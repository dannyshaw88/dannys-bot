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
import shutil
import subprocess
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

# Keep model downloads on the regular Hugging Face HTTP/LFS path. The optional
# Xet transport can open many concurrent range requests and overwhelm a user's
# connection, so this intentionally uses the conservative downloader.
os.environ["HF_HUB_DISABLE_XET"] = "1"
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "600")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "60")

# ── CPU thread cap ────────────────────────────────────────────────────────────
# PyTorch defaults to using every logical core, which causes fan spin even on
# GPU machines (CPU pre/post-processing). Default: half the cores, min 2.
_cpu_count: int = os.cpu_count() or 4
_default_cpu_threads: int = max(2, _cpu_count // 2)
_cpu_threads: int = int(os.environ.get("IMAGE_GEN_CPU_THREADS", str(_default_cpu_threads)))

# ── Global state ──────────────────────────────────────────────────────────────
_pipeline = None
_loaded_model: Optional[str] = None
_status = "idle"        # idle | loading | ready | error
_status_message = "Ready to load a model."
_loading_model_key: Optional[str] = None   # model being downloaded right now
_loading_from_cache: bool = False           # True when weights are already on disk
_loading_phase: str = "idle"                # checking_cache | hardware_check | downloading | loading_pipeline | moving_to_device
_loading_started_at: Optional[float] = None
_loading_detail: str = ""
_load_lock = threading.Lock()
_gpu_info_cache: Optional[dict] = None
_generation_progress: Optional[dict] = None
_generation_lock = threading.Lock()


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


def _model_cache_dir(model_key: str) -> Optional[Path]:
    """Return the exact Hugging Face cache directory for a registered model."""
    info = MODELS.get(model_key)
    if not info:
        return None
    parts = str(info["repo"]).split("/", 1)
    if len(parts) != 2:
        return None
    org, name = parts
    return Path(MODELS_DIR) / f"models--{org}--{name}"


def _nvidia_system_info() -> dict:
    """Read the adapter/driver that Windows exposes through nvidia-smi."""
    commands = ["nvidia-smi"]
    if os.name == "nt":
        system_root = os.environ.get("WINDIR", r"C:\Windows")
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        commands.extend([
            str(Path(system_root) / "System32" / "nvidia-smi.exe"),
            str(Path(program_files) / "NVIDIA Corporation" / "NVSMI" / "nvidia-smi.exe"),
        ])

    for command in commands:
        try:
            result = subprocess.run(
                [command, "--query-gpu=name,driver_version", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=3,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if result.returncode == 0 and result.stdout.strip():
                first = result.stdout.strip().splitlines()[0]
                name, _, driver = first.partition(",")
                return {
                    "detected": True,
                    "name": name.strip() or None,
                    "driver_version": driver.strip() or None,
                }
        except (OSError, subprocess.SubprocessError):
            pass
    return {"detected": False, "name": None, "driver_version": None}


def _get_gpu_info() -> dict:
    """
    Report whether the installed PyTorch build can actually use CUDA.
    A Windows Device Manager entry only proves the driver is installed; this
    check also validates the CUDA-enabled Python runtime used by image generation.
    """
    global _gpu_info_cache
    if _gpu_info_cache is not None:
        return _gpu_info_cache

    system = _nvidia_system_info()
    try:
        import torch

        torch_cuda_version = getattr(getattr(torch, "version", None), "cuda", None)
        torch_version = getattr(torch, "__version__", None)
        try:
            cuda_available = bool(torch.cuda.is_available())
        except Exception as exc:
            cuda_available = False
            cuda_error = str(exc)
        else:
            cuda_error = ""

        if cuda_available:
            device_name = torch.cuda.get_device_name(0)
            device_count = torch.cuda.device_count()
            capability = torch.cuda.get_device_capability(0)
            properties = torch.cuda.get_device_properties(0)
            # Pascal and older NVIDIA laptop GPUs, including the GTX 1050 Ti,
            # do not support bfloat16 efficiently. FP16 is the correct dtype.
            recommended_dtype = "float16" if capability[0] < 8 else "bfloat16"
            _gpu_info_cache = {
                "available": True,
                "backend": "CUDA",
                "name": device_name,
                "reason": "PyTorch CUDA is available and ready.",
                "torch_version": torch_version,
                "torch_cuda_version": torch_cuda_version,
                "system_gpu_detected": system["detected"],
                "system_gpu_name": system["name"],
                "driver_version": system["driver_version"],
                "device_count": device_count,
                "compute_capability": f"{capability[0]}.{capability[1]}",
                "vram_gb": round(properties.total_memory / (1024 ** 3), 2),
                "recommended_dtype": recommended_dtype,
            }
        elif not torch_cuda_version:
            _gpu_info_cache = {
                "available": False,
                "backend": "CPU",
                "name": system["name"],
                "reason": "The installed PyTorch package was built without CUDA support.",
                "torch_version": torch_version,
                "torch_cuda_version": None,
                "system_gpu_detected": system["detected"],
                "system_gpu_name": system["name"],
                "driver_version": system["driver_version"],
                "device_count": 0,
                "compute_capability": None,
                "vram_gb": None,
                "recommended_dtype": None,
            }
        elif cuda_error:
            _gpu_info_cache = {
                "available": False,
                "backend": "CPU",
                "name": system["name"],
                "reason": f"PyTorch could not initialize CUDA: {cuda_error}",
                "torch_version": torch_version,
                "torch_cuda_version": torch_cuda_version,
                "system_gpu_detected": system["detected"],
                "system_gpu_name": system["name"],
                "driver_version": system["driver_version"],
                "device_count": 0,
                "compute_capability": None,
                "vram_gb": None,
                "recommended_dtype": None,
            }
        else:
            _gpu_info_cache = {
                "available": False,
                "backend": "CPU",
                "name": system["name"],
                "reason": "PyTorch includes CUDA, but the NVIDIA driver/runtime did not expose a usable CUDA device.",
                "torch_version": torch_version,
                "torch_cuda_version": torch_cuda_version,
                "system_gpu_detected": system["detected"],
                "system_gpu_name": system["name"],
                "driver_version": system["driver_version"],
                "device_count": 0,
                "compute_capability": None,
                "vram_gb": None,
                "recommended_dtype": None,
            }
    except Exception as exc:
        _gpu_info_cache = {
            "available": False,
            "backend": "CPU",
            "name": system["name"],
            "reason": f"Could not inspect PyTorch CUDA: {exc}",
            "torch_version": None,
            "torch_cuda_version": None,
            "system_gpu_detected": system["detected"],
            "system_gpu_name": system["name"],
            "driver_version": system["driver_version"],
            "device_count": 0,
            "compute_capability": None,
            "vram_gb": None,
            "recommended_dtype": None,
        }
    return _gpu_info_cache


# ── Model registry ────────────────────────────────────────────────────────────
MODELS = {
    "qwen-image-edit-2511": {
        "label": "Qwen Image Edit 2511 (best ungated local editing, ~20 GB download)",
        "repo": "Qwen/Qwen-Image-Edit-2511",
        "pipeline_class": "QwenImageEditPlusPipeline",
        "default_steps": 40,
        "default_guidance": 4.0,
        "size_gb": 20,
        "supports_reference_image": True,
        "requires_reference_image": True,
        # Keep this permissive: CUDA is faster when available, but CPU loading
        # is still a valid fallback for machines without a usable Torch CUDA
        # runtime. It may take a long time and use substantial system RAM.
        "use_cpu_offload": True,
    },
    "longcat-image-edit": {
        "label": "LongCat Image Edit (reference-image editing, ~30 GB download)",
        "repo": "meituan-longcat/LongCat-Image-Edit",
        "pipeline_class": "LongCatImageEditPipeline",
        "default_steps": 50,
        "default_guidance": 4.5,
        "size_gb": 30,
        "supports_reference_image": True,
        "requires_reference_image": True,
        # LongCat's official model card documents CPU offload at roughly
        # 18 GB VRAM. Use that path when CUDA is available, while still
        # allowing a CPU-only fallback.
        "use_cpu_offload": True,
    },
}

# ── Request / response models ─────────────────────────────────────────────────
class CpuThreadsRequest(BaseModel):
    threads: int

class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str = ""
    model: str = "qwen-image-edit-2511"
    steps: Optional[int] = None
    guidance_scale: Optional[float] = None
    width: int = 1024
    height: int = 1024
    seed: Optional[int] = None
    init_image: Optional[str] = None        # base64 PNG/JPEG for img2img
    strength: float = 0.75                  # img2img: 0.0 = keep original, 1.0 = full redraw

class GenerateResponse(BaseModel):
    image_b64: str
    seed: int
    elapsed_ms: int
    filename: str

class LoadRequest(BaseModel):
    model: str = "qwen-image-edit-2511"

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
    global _pipeline, _loaded_model, _status, _status_message, _loading_model_key
    global _loading_from_cache, _loading_phase, _loading_started_at, _loading_detail

    if model_key not in MODELS:
        _status = "error"
        _status_message = f"Unknown model: {model_key}"
        return

    info = MODELS[model_key]
    if info.get("disabled"):
        _status = "error"
        _status_message = info.get("disabled_reason", "This model is not available.")
        return
    _loading_model_key = model_key
    _status = "loading"
    _loading_phase = "checking_cache"
    _loading_started_at = time.time()
    _loading_detail = "Checking the local model cache…"

    # Detect whether the weights are already cached so we can show the right message
    cached = _model_is_cached(model_key)
    _loading_from_cache = cached
    if cached:
        _loading_phase = "loading_pipeline"
        _status_message = f"Loading {info['label']} from cache…"
        _loading_detail = "Preparing the cached model pipeline…"
    else:
        _loading_phase = "downloading"
        _status_message = f"Downloading {info['label']} (~{info['size_gb']} GB — first run only)…"
        _loading_detail = "Downloading model weights…"
    log.info(_status_message)

    try:
        import torch

        # Detect the best available device, but do not reject the model here.
        # The previous version turned this into a hard CUDA/VRAM gate, which
        # prevented machines from attempting the slower CPU fallback.
        _loading_phase = "hardware_check"
        _status_message = "Selecting the best available processing device…"
        _loading_detail = "CUDA will be used when available; otherwise loading on the CPU…"
        gpu_info = _get_gpu_info()
        device = "cuda" if gpu_info["available"] else "cpu"
        if device == "cpu":
            _loading_detail = (
                "No usable Torch CUDA runtime detected; loading on the CPU. "
                "This can be slow and use substantial system RAM."
            )

        if info["pipeline_class"] == "QwenImageEditPlusPipeline":
            from diffusers import QwenImageEditPlusPipeline
            PipelineCls = QwenImageEditPlusPipeline
        elif info["pipeline_class"] == "LongCatImageEditPipeline":
            from diffusers import LongCatImageEditPipeline
            PipelineCls = LongCatImageEditPipeline
        else:
            raise RuntimeError(f"Unsupported image model pipeline: {info['pipeline_class']}")

        # Apply CPU thread cap before any computation
        torch.set_num_threads(_cpu_threads)
        torch.set_num_interop_threads(min(2, _cpu_threads))
        log.info(f"CPU threads: {_cpu_threads} / {_cpu_count} logical cores")

        dtype = (
            torch.float16
            if device == "cuda" and gpu_info.get("recommended_dtype") == "float16"
            else torch.bfloat16
            if device == "cuda"
            else torch.float32
        )

        # low_cpu_mem_usage avoids materialising a full second copy of the
        # weights during load, cutting peak RAM use roughly in half.
        load_kwargs: dict = {"torch_dtype": dtype, "cache_dir": MODELS_DIR, "low_cpu_mem_usage": True}

        if _loading_from_cache:
            _loading_phase = "loading_pipeline"
            _loading_detail = "Assembling the cached model components…"
        else:
            # from_pretrained() performs the Hugging Face download itself.
            # Keep this phase as "downloading" until it returns so the status
            # endpoint can expose live .incomplete-file progress.
            _loading_phase = "downloading"
            _loading_detail = "Downloading model weights…"
        try:
            import huggingface_hub
            hub_version = getattr(huggingface_hub, "__version__", "unknown")
        except Exception:
            hub_version = "unavailable"
        log.info(
            "Hugging Face download backend: "
            f"huggingface_hub={hub_version}, "
            "transport=regular HTTP/LFS, "
            f"HF_HUB_DISABLE_XET={os.environ.get('HF_HUB_DISABLE_XET', '')!r}"
        )
        log.info(f"Loading pipeline components for {model_key} (elapsed {time.time() - _loading_started_at:.0f}s)")
        pipe = PipelineCls.from_pretrained(info["repo"], **load_kwargs)
        log.info(
            f"Pipeline components assembled for {model_key} "
            f"(elapsed {time.time() - _loading_started_at:.0f}s); moving to {device.upper()}"
        )

        _loading_phase = "loading_pipeline"
        _loading_detail = "Assembling model components; diffusers does not expose percentage progress here…"
        _loading_phase = "moving_to_device"
        _loading_detail = f"Moving the assembled pipeline to {device.upper()} memory…"
        if device == "cuda":
            torch.backends.cuda.matmul.allow_tf32 = True
            if info.get("use_cpu_offload"):
                pipe.enable_model_cpu_offload()
            else:
                pipe = pipe.to(device)
        else:
            # CPU offload hooks are designed for a CUDA device with limited
            # VRAM. On a CPU-only machine they add transfer overhead to every
            # layer and can turn a minutes-long generation into 15+ minutes.
            pipe = pipe.to("cpu")
        log.info(f"Pipeline moved to {device.upper()} (elapsed {time.time() - _loading_started_at:.0f}s)")

        _pipeline = pipe
        _loaded_model = model_key
        _loading_model_key = None
        _loading_from_cache = False
        _loading_phase = "idle"
        _loading_started_at = None
        _loading_detail = ""
        _status = "ready"
        _status_message = f"Ready — {info['label']} on {device.upper()}"
        log.info(_status_message)

    except Exception as exc:
        _loading_model_key = None
        _loading_from_cache = False
        _loading_phase = "error"
        _loading_started_at = None
        _loading_detail = ""
        _status = "error"
        _status_message = str(exc)
        log.error(f"Failed to load model: {exc}")


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/status")
def get_status():
    phase = _loading_phase
    message = _status_message
    detail = _loading_detail
    if phase in {"loading_pipeline", "moving_to_device"} and _loading_model_key in MODELS:
        label = MODELS[_loading_model_key]["label"]
        message = (
            f"Preparing {label} in memory…"
            if phase == "moving_to_device"
            else f"Loading {label} into memory…"
        )
    return {
        "status": _status,
        "message": message,
        "loaded_model": _loaded_model,
        "loading_phase": phase,
        "loading_detail": detail,
        "loading_elapsed_seconds": (
            round(time.time() - _loading_started_at, 1)
            if _status == "loading" and _loading_started_at else None
        ),
        "available_models": {
            k: {
                "label": v["label"],
                "size_gb": v["size_gb"],
                "installed": _model_is_cached(k),
                "default_steps": v["default_steps"],
                "default_guidance": v["default_guidance"],
                "supports_reference_image": v.get("supports_reference_image", False),
                "requires_reference_image": v.get("requires_reference_image", False),
                "uses_cpu_offload": v.get("use_cpu_offload", False),
                "disabled": v.get("disabled", False),
                "disabled_reason": v.get("disabled_reason"),
            }
            for k, v in MODELS.items()
        },
        "cpu_threads": _cpu_threads,
        "cpu_count": _cpu_count,
        "gpu": _get_gpu_info(),
        "generation_progress": _generation_progress,
    }


@app.post("/cpu-threads")
def set_cpu_threads(req: CpuThreadsRequest):
    global _cpu_threads
    n = max(1, min(req.threads, _cpu_count))
    _cpu_threads = n
    # Apply immediately — affects the next generate() call; torch is not
    # imported at module level so guard the call.
    try:
        import torch
        torch.set_num_threads(n)
        torch.set_num_interop_threads(min(2, n))
    except Exception:
        pass
    log.info(f"CPU threads updated → {n}")
    return {"ok": True, "cpu_threads": n}


@app.post("/unload")
def unload_model():
    """Release the pipeline from memory so the rest of the app gets its RAM back."""
    global _pipeline, _loaded_model, _status, _status_message, _loading_phase
    global _loading_started_at, _loading_detail
    import gc
    _pipeline = None
    _loaded_model = None
    _loading_phase = "idle"
    _loading_started_at = None
    _loading_detail = ""
    _status = "idle"
    _status_message = "Model unloaded — RAM freed."
    try:
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        gc.collect()
    log.info("Model unloaded, RAM freed")
    return {"ok": True}


class DeleteModelRequest(BaseModel):
    model: str


@app.post("/delete-model")
def delete_model(req: DeleteModelRequest):
    """Delete one registered model's downloaded Hugging Face cache from disk."""
    global _pipeline, _loaded_model, _status, _status_message

    if req.model not in MODELS:
        raise HTTPException(status_code=400, detail="Unknown model")
    if _status == "loading" and _loading_model_key == req.model:
        raise HTTPException(status_code=409, detail="This model is still loading — wait for the download to finish.")

    # A loaded pipeline may hold open files and GPU memory. Release it before
    # removing the corresponding cache directory.
    if _loaded_model == req.model:
        _pipeline = None
        _loaded_model = None
        _status = "idle"
        try:
            import gc
            gc.collect()
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    cache_dir = _model_cache_dir(req.model)
    freed_bytes = 0
    if cache_dir and cache_dir.exists():
        for file_path in cache_dir.rglob("*"):
            try:
                if file_path.is_file():
                    freed_bytes += file_path.stat().st_size
            except OSError:
                pass
        shutil.rmtree(cache_dir)

    info = MODELS[req.model]
    _status = "idle"
    _status_message = f"{info['label']} removed from disk."
    log.info(f"Deleted model cache: {req.model} ({freed_bytes} bytes)")
    return {
        "ok": True,
        "model": req.model,
        "freed_bytes": freed_bytes,
        "message": f"{info['label']} removed from disk.",
    }


@app.post("/load")
def load_model(req: LoadRequest):
    global _status
    info = MODELS.get(req.model)
    if info is None:
        raise HTTPException(status_code=400, detail="Unknown model")
    if info.get("disabled"):
        raise HTTPException(
            status_code=403,
            detail=info.get("disabled_reason", "This model is not available."),
        )
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
    global _pipeline, _loaded_model, _status, _generation_progress

    requested_info = MODELS.get(req.model)
    if requested_info is None:
        raise HTTPException(status_code=400, detail=f"Unknown model '{req.model}'")
    if requested_info.get("disabled"):
        raise HTTPException(
            status_code=403,
            detail=requested_info.get("disabled_reason", "This model is not available."),
        )

    # Auto-load synchronously if nothing is loaded yet
    if _pipeline is None or _loaded_model != req.model:
        if _status == "loading":
            raise HTTPException(status_code=503, detail="Model is still loading — please wait")
        with _load_lock:
            _do_load(req.model)
        if _pipeline is None:
            raise HTTPException(status_code=500, detail=_status_message)

    info = MODELS[req.model]
    if info.get("requires_reference_image") and not req.init_image:
        raise HTTPException(
            status_code=400,
            detail=f"{info['label']} requires an input or reference image.",
        )
    steps = req.steps if req.steps is not None else info["default_steps"]
    guidance = req.guidance_scale if req.guidance_scale is not None else info["default_guidance"]

    import torch
    import random

    seed = req.seed if req.seed is not None else random.randint(0, 2**32 - 1)
    generator = torch.Generator().manual_seed(seed)
    with _generation_lock:
        _generation_progress = {
            "current_step": 0,
            "total_steps": steps,
            "percent": 0,
            "elapsed_seconds": 0,
            "phase": "Starting",
        }

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

        def on_step_end(_pipe, step_index, _timestep, callback_kwargs):
            global _generation_progress
            current_step = min(step_index + 1, steps)
            with _generation_lock:
                _generation_progress = {
                    "current_step": current_step,
                    "total_steps": steps,
                    "percent": round(current_step / max(steps, 1) * 100),
                    "elapsed_seconds": round(time.time() - t0, 1),
                    "phase": "Denoising",
                }
            return callback_kwargs

        kwargs["callback_on_step_end"] = on_step_end

        # Both supported models are reference-image editors. Keep this path
        # deliberately small: one image input, one pipeline call, no legacy
        # text-to-image or adapter downloads.
        from PIL import Image as PILImage
        img_bytes = base64.b64decode(req.init_image)
        init_img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
        init_img = init_img.resize((req.width, req.height), PILImage.LANCZOS)
        kwargs["image"] = [init_img] if req.model == "qwen-image-edit-2511" else init_img
        kwargs["num_images_per_prompt"] = 1
        kwargs.pop("callback_on_step_end", None)
        if req.model == "qwen-image-edit-2511":
            kwargs["true_cfg_scale"] = guidance
            kwargs["guidance_scale"] = 1.0
            kwargs["negative_prompt"] = req.negative_prompt or " "
        else:
            kwargs["guidance_scale"] = guidance
        with torch.inference_mode():
            result = _pipeline(**kwargs)

        image = result.images[0]

    except HTTPException:
        with _generation_lock:
            _generation_progress = None
        raise
    except Exception as exc:
        with _generation_lock:
            _generation_progress = None
        raise HTTPException(status_code=500, detail=str(exc))

    elapsed_ms = int((time.time() - t0) * 1000)
    with _generation_lock:
        _generation_progress = None

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
