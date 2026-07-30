"""
Aura Farming — Local Image Generation Sidecar
FastAPI server that wraps HuggingFace diffusers for GPU-accelerated image generation.
Spawned by Electron as a background process; the React frontend talks to it via
the Express API server which proxies /api/image-gen/* → this server.
"""
import os
import sys

# The Windows Python Embeddable distribution uses a python312._pth file that
# overrides sys.path and ignores the PYTHONPATH environment variable entirely.
# We manually inject the pip package directory (set by Electron via PYTHONPATH)
# at the very top — before any third-party imports — so torch/diffusers resolve.
_pip_dir = os.environ.get("PYTHONPATH", "")
if _pip_dir and _pip_dir not in sys.path:
    sys.path.insert(0, _pip_dir)

import io
import base64
import time
import threading
import logging
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="[image-gen] %(levelname)s %(message)s",
)
log = logging.getLogger("image-gen")

# ── Config from environment ────────────────────────────────────────────────────
PORT = int(os.environ.get("IMAGE_GEN_PORT", "17860"))
MODELS_DIR = os.environ.get(
    "IMAGE_GEN_MODELS_DIR",
    str(Path.home() / "AppData" / "Local" / "AuraFarming" / "image-gen-models"),
)
OUTPUT_DIR = os.environ.get(
    "IMAGE_GEN_OUTPUT_DIR",
    str(Path.home() / "AppData" / "Local" / "AuraFarming" / "image-gen-output"),
)

Path(MODELS_DIR).mkdir(parents=True, exist_ok=True)
Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

# ── Global state ──────────────────────────────────────────────────────────────
_pipeline = None
_loaded_model: Optional[str] = None
_status = "idle"        # idle | loading | ready | error
_status_message = "Ready to load a model."
_loading_model_key: Optional[str] = None   # model being downloaded right now
_loading_from_cache: bool = False           # True when weights are already on disk
_load_lock = threading.Lock()


def _model_is_cached(model_key: str) -> bool:
    """Return True if the model's blob files already exist in MODELS_DIR."""
    if model_key not in MODELS:
        return False
    info = MODELS[model_key]
    repo: str = info["repo"]
    parts = repo.split("/", 1)
    if len(parts) != 2:
        return False
    org, name = parts
    blobs_dir = Path(MODELS_DIR) / f"models--{org}--{name}" / "blobs"
    if not blobs_dir.exists():
        return False
    # At least one shard larger than 100 KB means real model weights are present
    return any(
        f.is_file() and f.stat().st_size > 100 * 1024
        for f in blobs_dir.iterdir()
    )


def _get_download_progress() -> Optional[dict]:
    """
    Estimate download progress by summing blob file sizes in the HuggingFace
    cache directory.  Called only while _status == "loading".
    Returns {"downloaded_bytes": int, "total_bytes": int} or None.
    """
    if _loading_model_key is None or _loading_model_key not in MODELS:
        return None

    info = MODELS[_loading_model_key]
    total_bytes = int(info["size_gb"] * 1024 * 1024 * 1024)

    # HuggingFace Hub stores blobs under:
    #   <cache_dir>/models--<org>--<name>/blobs/
    repo: str = info["repo"]
    parts = repo.split("/", 1)
    if len(parts) != 2:
        return None
    org, name = parts
    blobs_dir = Path(MODELS_DIR) / f"models--{org}--{name}" / "blobs"

    downloaded = 0
    if blobs_dir.exists():
        for f in blobs_dir.iterdir():
            try:
                downloaded += f.stat().st_size
            except OSError:
                pass

    # Cap at total_bytes (size_gb is approximate)
    downloaded = min(downloaded, total_bytes)
    return {"downloaded_bytes": downloaded, "total_bytes": total_bytes}

# ── Model registry ────────────────────────────────────────────────────────────
MODELS = {
    "flux-schnell": {
        "label": "FLUX.1-schnell (Recommended — 4-step, fast, ~16 GB download)",
        "repo": "black-forest-labs/FLUX.1-schnell",
        "pipeline_class": "FluxPipeline",
        "default_steps": 4,
        "default_guidance": 0.0,
        "size_gb": 16,
    },
    "sdxl-turbo": {
        "label": "SDXL-Turbo (1-step, very fast, ~6.5 GB download)",
        "repo": "stabilityai/sdxl-turbo",
        "pipeline_class": "AutoPipelineForText2Image",
        "default_steps": 1,
        "default_guidance": 0.0,
        "size_gb": 6.5,
    },
    "sdxl": {
        "label": "Stable Diffusion XL (30-step, best quality, ~7 GB download)",
        "repo": "stabilityai/stable-diffusion-xl-base-1.0",
        "pipeline_class": "StableDiffusionXLPipeline",
        "default_steps": 30,
        "default_guidance": 7.5,
        "size_gb": 7,
    },
}

# ── Request / response models ─────────────────────────────────────────────────
class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str = ""
    model: str = "flux-schnell"
    steps: Optional[int] = None
    guidance_scale: Optional[float] = None
    width: int = 1024
    height: int = 1024
    seed: Optional[int] = None
    init_image: Optional[str] = None   # base64-encoded PNG/JPEG for img2img
    strength: float = 0.75             # 0.0 = keep original, 1.0 = full generation

class GenerateResponse(BaseModel):
    image_b64: str
    seed: int
    elapsed_ms: int
    filename: str

class LoadRequest(BaseModel):
    model: str = "flux-schnell"

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="Aura Farming Image Gen")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Load pipeline (runs in a background thread) ───────────────────────────────
def _do_load(model_key: str) -> None:
    global _pipeline, _loaded_model, _status, _status_message, _loading_model_key, _loading_from_cache

    if model_key not in MODELS:
        _status = "error"
        _status_message = f"Unknown model: {model_key}"
        return

    info = MODELS[model_key]
    _loading_model_key = model_key
    _status = "loading"

    # Detect whether the weights are already cached so we can show the right message
    cached = _model_is_cached(model_key)
    _loading_from_cache = cached
    if cached:
        _status_message = f"Loading {info['label']} from cache…"
    else:
        _status_message = f"Downloading {info['label']} (~{info['size_gb']} GB — first run only)…"
    log.info(_status_message)

    try:
        import torch
        from diffusers import (
            FluxPipeline,
            AutoPipelineForText2Image,
            StableDiffusionXLPipeline,
        )

        _cls_map = {
            "FluxPipeline": FluxPipeline,
            "AutoPipelineForText2Image": AutoPipelineForText2Image,
            "StableDiffusionXLPipeline": StableDiffusionXLPipeline,
        }
        PipelineCls = _cls_map[info["pipeline_class"]]

        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.bfloat16 if device == "cuda" else torch.float32

        pipe = PipelineCls.from_pretrained(
            info["repo"],
            torch_dtype=dtype,
            cache_dir=MODELS_DIR,
        )

        if device == "cuda":
            pipe = pipe.to(device)
        else:
            # enable_sequential_cpu_offload requires the `accelerate` library.
            # Fall back to a plain .to("cpu") if it's not installed.
            try:
                pipe.enable_sequential_cpu_offload()
            except Exception:
                pipe = pipe.to("cpu")

        _pipeline = pipe
        _loaded_model = model_key
        _loading_model_key = None
        _loading_from_cache = False
        _status = "ready"
        _status_message = f"Ready — {info['label']} on {device.upper()}"
        log.info(_status_message)

    except Exception as exc:
        _loading_model_key = None
        _loading_from_cache = False
        _status = "error"
        _status_message = str(exc)
        log.error(f"Failed to load model: {exc}")


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/status")
def get_status():
    return {
        "status": _status,
        "message": _status_message,
        "loaded_model": _loaded_model,
        "download_progress": _get_download_progress() if _status == "loading" and not _loading_from_cache else None,
        "available_models": {
            k: {
                "label": v["label"],
                "size_gb": v["size_gb"],
                "default_steps": v["default_steps"],
                "default_guidance": v["default_guidance"],
            }
            for k, v in MODELS.items()
        },
    }


@app.post("/load")
def load_model(req: LoadRequest):
    global _status
    if _loaded_model == req.model and _status == "ready":
        return {"ok": True, "message": "Already loaded"}
    if _status == "loading":
        return {"ok": False, "message": "Already loading — please wait"}
    with _load_lock:
        t = threading.Thread(target=_do_load, args=(req.model,), daemon=True)
        t.start()
    return {"ok": True, "message": f"Loading {req.model}…"}


@app.post("/generate")
def generate(req: GenerateRequest):
    global _pipeline, _loaded_model, _status

    # Auto-load synchronously if nothing is loaded yet
    if _pipeline is None or _loaded_model != req.model:
        if _status == "loading":
            raise HTTPException(status_code=503, detail="Model is still loading — please wait")
        with _load_lock:
            _do_load(req.model)
        if _pipeline is None:
            raise HTTPException(status_code=500, detail=_status_message)

    info = MODELS.get(req.model, MODELS["flux-schnell"])
    steps = req.steps if req.steps is not None else info["default_steps"]
    guidance = req.guidance_scale if req.guidance_scale is not None else info["default_guidance"]

    import torch
    import random

    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)
    generator = torch.Generator().manual_seed(seed)

    t0 = time.time()
    try:
        kwargs: dict = {
            "prompt": req.prompt,
            "num_inference_steps": steps,
            "generator": generator,
        }
        if guidance > 0:
            kwargs["guidance_scale"] = guidance
        if req.negative_prompt:
            kwargs["negative_prompt"] = req.negative_prompt

        if req.init_image:
            # ── Image-to-image ────────────────────────────────────────────────
            # Reuse the loaded pipeline's weights via from_pipe() — no re-download.
            from PIL import Image as PILImage
            from diffusers import (
                FluxImg2ImgPipeline,
                StableDiffusionXLImg2ImgPipeline,
                AutoPipelineForImage2Image,
            )
            _img2img_cls_map = {
                "FluxPipeline":             FluxImg2ImgPipeline,
                "StableDiffusionXLPipeline": StableDiffusionXLImg2ImgPipeline,
                "AutoPipelineForText2Image": AutoPipelineForImage2Image,
            }
            pipeline_class = info.get("pipeline_class", "")
            Img2ImgCls = _img2img_cls_map.get(pipeline_class)
            if Img2ImgCls is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Image-to-image is not supported for model '{req.model}'"
                )

            img_bytes = base64.b64decode(req.init_image)
            init_img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
            # Resize to requested output dimensions so the pipeline doesn't complain
            init_img = init_img.resize((req.width, req.height), PILImage.LANCZOS)

            img2img_pipe = Img2ImgCls.from_pipe(_pipeline)
            kwargs["image"] = init_img
            kwargs["strength"] = req.strength
            # img2img pipelines derive output size from the input image — no width/height kwarg
            result = img2img_pipe(**kwargs)
        else:
            # ── Text-to-image (original path) ─────────────────────────────────
            kwargs["width"] = req.width
            kwargs["height"] = req.height
            result = _pipeline(**kwargs)

        image = result.images[0]

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    elapsed_ms = int((time.time() - t0) * 1000)

    # Save to output directory
    ts = int(time.time() * 1000)
    filename = f"aura-img-{ts}-seed{seed}.png"
    out_path = Path(OUTPUT_DIR) / filename
    image.save(str(out_path))

    # Encode as base64 for the HTTP response
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    return GenerateResponse(
        image_b64=b64,
        seed=seed,
        elapsed_ms=elapsed_ms,
        filename=filename,
    )


@app.get("/output")
def list_output():
    files = sorted(Path(OUTPUT_DIR).glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    return {"images": [f.name for f in files[:100]]}


@app.get("/output/{filename}")
def get_output_image(filename: str):
    # Basic path traversal guard
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    p = Path(OUTPUT_DIR) / filename
    if not p.exists() or p.suffix != ".png":
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(str(p), media_type="image/png")


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info(f"Starting Aura Farming image-gen server on port {PORT}")
    log.info(f"Models dir: {MODELS_DIR}")
    log.info(f"Output dir: {OUTPUT_DIR}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
