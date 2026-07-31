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
_ip_adapter_loaded: bool = False            # True once IP-Adapter weights are loaded onto _pipeline
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
    incomplete_bytes = 0
    if blobs_dir.exists():
        for f in blobs_dir.iterdir():
            try:
                size = f.stat().st_size
                # Hugging Face writes active transfers as *.incomplete. Those
                # bytes are not usable model blobs and must not count toward
                # the completed-download display.
                if f.name.endswith(".incomplete"):
                    incomplete_bytes += size
                elif f.is_file():
                    downloaded += size
            except OSError:
                pass

    # size_gb is an intentionally approximate registry value. Never let the
    # progress bar claim a completed download while an active .incomplete
    # transfer still exists; the pipeline load phase will follow once the
    # estimate is reached.
    download_complete = downloaded >= total_bytes and incomplete_bytes == 0
    return {
        "downloaded_bytes": min(downloaded, total_bytes),
        "total_bytes": total_bytes,
        "download_complete": download_complete,
        "incomplete_bytes": incomplete_bytes,
    }

# ── Model registry ────────────────────────────────────────────────────────────
MODELS = {
    "flux-schnell": {
        "label": "FLUX.1-schnell (Recommended — 4-step, fast, ~16 GB download)",
        "repo": "black-forest-labs/FLUX.1-schnell",
        "pipeline_class": "FluxPipeline",
        "default_steps": 4,
        "default_guidance": 0.0,
        "size_gb": 16,
        "supports_ip_adapter": False,
    },
    "sdxl-turbo": {
        "label": "SDXL-Turbo (1-step, very fast, ~6.5 GB download)",
        "repo": "stabilityai/sdxl-turbo",
        "pipeline_class": "AutoPipelineForText2Image",
        "default_steps": 1,
        "default_guidance": 0.0,
        "size_gb": 6.5,
        "supports_ip_adapter": True,
    },
    "sdxl": {
        "label": "Stable Diffusion XL (30-step, best quality, ~7 GB download)",
        "repo": "stabilityai/stable-diffusion-xl-base-1.0",
        "pipeline_class": "StableDiffusionXLPipeline",
        "default_steps": 30,
        "default_guidance": 7.5,
        "size_gb": 7,
        "supports_ip_adapter": True,
    },
    "flux-dev": {
        "label": "FLUX.1-dev (50-step, highest quality, ~24 GB download)",
        "repo": "black-forest-labs/FLUX.1-dev",
        "pipeline_class": "FluxPipeline",
        "default_steps": 50,
        "default_guidance": 3.5,
        "size_gb": 24,
        "supports_ip_adapter": False,
    },
    "flux2-klein-4b": {
        "label": "FLUX.2 [klein] 4B (4-step, generation + editing, ~24 GB download)",
        "repo": "black-forest-labs/FLUX.2-klein-4B",
        "pipeline_class": "Flux2KleinPipeline",
        "default_steps": 4,
        "default_guidance": 1.0,
        "size_gb": 24,
        "supports_ip_adapter": False,
        "supports_reference_image": True,
        "requires_reference_image": False,
        "use_cpu_offload": True,
        "minimum_vram_gb": 13,
        "recommended_vram_gb": 16,
    },
    "flux2-dev": {
        "label": "FLUX.2 [dev] — LICENSE REQUIRED (gated, ~178 GB download)",
        "repo": "black-forest-labs/FLUX.2-dev",
        "disabled": True,
        "disabled_reason": "Hugging Face license acceptance is required before this model can be downloaded.",
        "size_gb": 178,
        "default_steps": 50,
        "default_guidance": 4.0,
        "supports_reference_image": True,
    },
    "qwen-image-edit-2511": {
        "label": "Qwen Image Edit 2511 (best ungated local editing, ~20 GB download)",
        "repo": "Qwen/Qwen-Image-Edit-2511",
        "pipeline_class": "QwenImageEditPlusPipeline",
        "default_steps": 40,
        "default_guidance": 4.0,
        "size_gb": 20,
        "supports_ip_adapter": False,
        "supports_reference_image": True,
        "requires_reference_image": True,
        # The current loader places the complete pipeline on CUDA; it does
        # not use CPU/disk offload. Refuse clearly undersized GPUs before
        # diffusers spends minutes materialising a pipeline that cannot fit.
        "minimum_vram_gb": 16,
        "recommended_vram_gb": 24,
    },
    "longcat-image-edit": {
        "label": "LongCat Image Edit (reference-image editing, ~30 GB download)",
        "repo": "meituan-longcat/LongCat-Image-Edit",
        "pipeline_class": "LongCatImageEditPipeline",
        "default_steps": 50,
        "default_guidance": 4.5,
        "size_gb": 30,
        "supports_ip_adapter": False,
        "supports_reference_image": True,
        "requires_reference_image": True,
        # LongCat's official model card documents CPU offload at roughly
        # 18 GB VRAM. Use that documented offload path instead of requiring
        # the entire pipeline to remain resident on the GPU.
        "use_cpu_offload": True,
        "minimum_vram_gb": 18,
        "recommended_vram_gb": 24,
    },
    "sd3-medium": {
        "label": "Stable Diffusion 3 Medium (28-step, great quality, ~5 GB download)",
        "repo": "stabilityai/stable-diffusion-3-medium-diffusers",
        "pipeline_class": "StableDiffusion3Pipeline",
        "default_steps": 28,
        "default_guidance": 7.0,
        "size_gb": 5,
        "supports_ip_adapter": False,
    },
    "sd35-large": {
        "label": "Stable Diffusion 3.5 Large — LICENSE REQUIRED (~75 GB download)",
        "repo": "stabilityai/stable-diffusion-3.5-large",
        "disabled": True,
        "disabled_reason": "Hugging Face license acceptance is required before this model can be downloaded.",
        "size_gb": 75,
        "default_steps": 28,
        "default_guidance": 4.5,
    },
    "sd35-large-turbo": {
        "label": "Stable Diffusion 3.5 Large Turbo — LICENSE REQUIRED (~59 GB download)",
        "repo": "stabilityai/stable-diffusion-3.5-large-turbo",
        "disabled": True,
        "disabled_reason": "Hugging Face license acceptance is required before this model can be downloaded.",
        "size_gb": 59,
        "default_steps": 4,
        "default_guidance": 0.0,
    },
    "realvisxl": {
        "label": "RealVisXL v4 (30-step, photorealistic, unrestricted, ~7 GB download)",
        "repo": "SG161222/RealVisXL_V4.0",
        "pipeline_class": "StableDiffusionXLPipeline",
        "default_steps": 30,
        "default_guidance": 7.0,
        "size_gb": 7,
        "supports_ip_adapter": True,
    },
    "dreamshaper-xl": {
        "label": "DreamShaper XL (8-step, fast + unrestricted, ~7 GB download)",
        "repo": "Lykon/dreamshaper-xl-v2-turbo",
        "pipeline_class": "StableDiffusionXLPipeline",
        "default_steps": 8,
        "default_guidance": 2.0,
        "size_gb": 7,
        "supports_ip_adapter": True,
    },
    "z-image-turbo": {
        "label": "Z-Image-Turbo (8-step, photorealistic + strong text, ~24 GB download)",
        "repo": "Tongyi-MAI/Z-Image-Turbo",
        "pipeline_class": "ZImagePipeline",
        "default_steps": 8,
        "default_guidance": 0.0,
        "size_gb": 24,
        "supports_ip_adapter": False,
        # The official model card targets 16 GB consumer GPUs. The current
        # loader keeps the complete pipeline on one device, so fail clearly
        # below that threshold instead of spending time assembling a pipeline
        # that cannot fit.
        "minimum_vram_gb": 16,
        "recommended_vram_gb": 24,
        # Tongyi-MAI/Z-Image-Turbo is Apache-2.0 and ungated on Hugging Face;
        # weights are downloaded into the local cache and inference is local.
    },
}

# ── Request / response models ─────────────────────────────────────────────────
class CpuThreadsRequest(BaseModel):
    threads: int

class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str = ""
    model: str = "flux-schnell"
    steps: Optional[int] = None
    guidance_scale: Optional[float] = None
    width: int = 1024
    height: int = 1024
    seed: Optional[int] = None
    init_image: Optional[str] = None        # base64 PNG/JPEG for img2img
    strength: float = 0.75                  # img2img: 0.0 = keep original, 1.0 = full redraw
    ip_adapter_image: Optional[str] = None  # base64 reference photo for character lock
    ip_adapter_scale: float = 0.6           # 0.0 = ignore reference, 1.0 = copy exactly

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
    global _pipeline, _loaded_model, _status, _status_message, _loading_model_key
    global _loading_from_cache, _loading_phase, _loading_started_at, _loading_detail
    global _ip_adapter_loaded

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

        # Check hardware before importing/assembling the large diffusers
        # pipeline. CUDA availability only means that PyTorch can talk to the
        # GPU; it does not mean this model can fit in that GPU's VRAM.
        _loading_phase = "hardware_check"
        _status_message = "Checking whether this computer can load the selected model…"
        _loading_detail = "Checking GPU memory and runtime compatibility…"
        gpu_info = _get_gpu_info()
        device = "cuda" if gpu_info["available"] else "cpu"
        minimum_vram = info.get("minimum_vram_gb")
        if device == "cuda" and minimum_vram:
            actual_vram = gpu_info.get("vram_gb")
            if actual_vram is None:
                # Never attempt to assemble a very large full-GPU pipeline when
                # the runtime cannot prove how much VRAM is available.
                raise RuntimeError(
                    f"Could not measure VRAM for {gpu_info.get('name') or 'the CUDA device'}. "
                    f"{info['label']} requires at least {minimum_vram} GB of VRAM in the current "
                    "full-GPU loader. Choose SDXL-Turbo or another smaller model, or use a machine "
                    "with more VRAM."
                )
            if actual_vram < minimum_vram:
                raise RuntimeError(
                    f"{info['label']} needs at least {minimum_vram} GB of VRAM in the current full-GPU loader, "
                    f"but {gpu_info.get('name') or 'this GPU'} has {actual_vram} GB. "
                    "Choose SDXL-Turbo or another smaller model, or use a machine with more VRAM."
                )

        if device == "cpu" and info.get("minimum_vram_gb"):
            _loading_detail = "No CUDA runtime detected; loading the large model into system RAM…"

        from diffusers import (
            FluxPipeline,
            AutoPipelineForText2Image,
            StableDiffusionXLPipeline,
            StableDiffusion3Pipeline,
            ZImagePipeline,
        )

        from diffusers import StableDiffusionPipeline
        _cls_map = {
            "FluxPipeline": FluxPipeline,
            "AutoPipelineForText2Image": AutoPipelineForText2Image,
            "StableDiffusionXLPipeline": StableDiffusionXLPipeline,
            "StableDiffusion3Pipeline": StableDiffusion3Pipeline,
            "StableDiffusionPipeline": StableDiffusionPipeline,
            "ZImagePipeline": ZImagePipeline,
        }
        if info["pipeline_class"] == "QwenImageEditPlusPipeline":
            from diffusers import QwenImageEditPlusPipeline
            PipelineCls = QwenImageEditPlusPipeline
        elif info["pipeline_class"] == "LongCatImageEditPipeline":
            from diffusers import LongCatImageEditPipeline
            PipelineCls = LongCatImageEditPipeline
        elif info["pipeline_class"] == "Flux2KleinPipeline":
            from diffusers import Flux2KleinPipeline
            PipelineCls = Flux2KleinPipeline
        else:
            PipelineCls = _cls_map[info["pipeline_class"]]

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

        # SD 1.x pipelines ship with a safety checker that blacks out flagged
        # outputs. Disable it so the model runs unrestricted on local hardware.
        # SDXL, FLUX, and SD3 have no safety checker in diffusers — no-op there.
        if info["pipeline_class"] == "StableDiffusionPipeline":
            load_kwargs["safety_checker"] = None
            load_kwargs["requires_safety_checker"] = False

        _loading_phase = "loading_pipeline"
        _loading_detail = "Assembling model components; diffusers does not expose percentage progress here…"
        log.info(f"Loading pipeline components for {model_key} (elapsed {time.time() - _loading_started_at:.0f}s)")
        pipe = PipelineCls.from_pretrained(info["repo"], **load_kwargs)

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

        _pipeline = pipe
        _loaded_model = model_key
        _loading_model_key = None
        _loading_from_cache = False
        _loading_phase = "idle"
        _loading_started_at = None
        _loading_detail = ""
        _ip_adapter_loaded = False   # new pipeline — IP-Adapter must be reloaded
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
    progress = _get_download_progress() if _status == "loading" and not _loading_from_cache else None
    phase = _loading_phase
    # A cache estimate can reach 100% before the loader has finished its
    # hardware check. Never let download progress hide that more meaningful
    # phase in the UI.
    if _status == "loading" and phase == "downloading" and progress and progress.get("download_complete"):
        phase = "loading_pipeline"
    message = _status_message
    detail = _loading_detail
    if phase in {"loading_pipeline", "moving_to_device"} and _loading_model_key in MODELS:
        label = MODELS[_loading_model_key]["label"]
        message = (
            f"Download complete. Moving {label} into memory…"
            if phase == "moving_to_device"
            else f"Download estimate reached. Loading {label} into memory…"
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
        "download_progress": progress,
        "available_models": {
            k: {
                "label": v["label"],
                "size_gb": v["size_gb"],
                "installed": _model_is_cached(k),
                "default_steps": v["default_steps"],
                "default_guidance": v["default_guidance"],
                "supports_ip_adapter": v.get("supports_ip_adapter", False),
                "supports_reference_image": v.get("supports_reference_image", False),
                "requires_reference_image": v.get("requires_reference_image", False),
                "uses_cpu_offload": v.get("use_cpu_offload", False),
                "disabled": v.get("disabled", False),
                "disabled_reason": v.get("disabled_reason"),
                "minimum_vram_gb": v.get("minimum_vram_gb"),
                "recommended_vram_gb": v.get("recommended_vram_gb"),
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
    global _loading_started_at, _loading_detail, _ip_adapter_loaded
    import gc
    _pipeline = None
    _loaded_model = None
    _ip_adapter_loaded = False
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
    global _pipeline, _loaded_model, _status, _status_message, _ip_adapter_loaded

    if req.model not in MODELS:
        raise HTTPException(status_code=400, detail="Unknown model")
    if _status == "loading" and _loading_model_key == req.model:
        raise HTTPException(status_code=409, detail="This model is still loading — wait for the download to finish.")

    # A loaded pipeline may hold open files and GPU memory. Release it before
    # removing the corresponding cache directory.
    if _loaded_model == req.model:
        _pipeline = None
        _loaded_model = None
        _ip_adapter_loaded = False
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
    global _pipeline, _loaded_model, _status, _ip_adapter_loaded, _generation_progress

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

    info = MODELS.get(req.model, MODELS["flux-schnell"])
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

        # ── IP-Adapter character lock ─────────────────────────────────────────
        # Loads IP-Adapter weights lazily (first request that uses it; ~300 MB).
        # set_ip_adapter_scale(0) disables it without unloading for requests
        # that don't use it, so reload cost is only paid once per model session.
        if req.ip_adapter_image and info.get("supports_ip_adapter"):
            from PIL import Image as PILImage
            if not _ip_adapter_loaded:
                with _generation_lock:
                    _generation_progress = {
                        "current_step": 0,
                        "total_steps": steps,
                        "percent": 0,
                        "elapsed_seconds": round(time.time() - t0, 1),
                        "phase": "Loading character adapter",
                    }
                log.info("Loading IP-Adapter SDXL weights (~300 MB one-time download)…")
                _pipeline.load_ip_adapter(
                    "h94/IP-Adapter",
                    subfolder="sdxl_models",
                    weight_name="ip-adapter_sdxl.bin",
                    cache_dir=MODELS_DIR,
                )
                _ip_adapter_loaded = True
            _pipeline.set_ip_adapter_scale(req.ip_adapter_scale)
            ref_bytes = base64.b64decode(req.ip_adapter_image)
            ref_img = PILImage.open(io.BytesIO(ref_bytes)).convert("RGB")
            kwargs["ip_adapter_image"] = ref_img
            log.info(f"IP-Adapter enabled — scale {req.ip_adapter_scale}")
        elif _ip_adapter_loaded:
            # Reference image not provided this request — mute the adapter
            _pipeline.set_ip_adapter_scale(0.0)

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

        pipeline_class = info.get("pipeline_class", "")
        if pipeline_class == "Flux2KleinPipeline":
            # FLUX.2 Klein uses one unified pipeline for text-to-image and
            # multi-reference image editing. It accepts image= directly,
            # but does not accept the generic negative_prompt or callback
            # shape used by the older pipelines in this server.
            kwargs.pop("negative_prompt", None)
            kwargs.pop("callback_on_step_end", None)
            kwargs["width"] = req.width
            kwargs["height"] = req.height
            if req.init_image:
                img_bytes = base64.b64decode(req.init_image)
                init_img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
                kwargs["image"] = init_img.resize((req.width, req.height), PILImage.LANCZOS)
            with torch.inference_mode():
                result = _pipeline(**kwargs)
        elif req.init_image:
            # ── Image-to-image ────────────────────────────────────────────────
            # Reuse the loaded pipeline's weights via from_pipe() — no re-download.
            from PIL import Image as PILImage
            if pipeline_class == "QwenImageEditPlusPipeline":
                img_bytes = base64.b64decode(req.init_image)
                init_img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
                init_img = init_img.resize((req.width, req.height), PILImage.LANCZOS)
                # Qwen Image Edit Plus takes one or more reference images as a
                # list and uses true_cfg_scale for prompt adherence.
                kwargs["image"] = [init_img]
                kwargs["true_cfg_scale"] = guidance
                kwargs["guidance_scale"] = 1.0
                kwargs["negative_prompt"] = req.negative_prompt or " "
                kwargs["num_images_per_prompt"] = 1
                with torch.inference_mode():
                    result = _pipeline(**kwargs)
                image = result.images[0]
                elapsed_ms = int((time.time() - t0) * 1000)
                with _generation_lock:
                    _generation_progress = None
                ts = int(time.time() * 1000)
                filename = f"aura-img-{ts}-seed{seed}.png"
                out_path = Path(OUTPUT_DIR) / filename
                image.save(str(out_path))
                buf = io.BytesIO()
                image.save(buf, format="PNG")
                b64 = base64.b64encode(buf.getvalue()).decode()
                return GenerateResponse(
                    image_b64=b64,
                    seed=seed,
                    elapsed_ms=elapsed_ms,
                    filename=filename,
                )
            if pipeline_class == "LongCatImageEditPipeline":
                img_bytes = base64.b64decode(req.init_image)
                init_img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
                init_img = init_img.resize((req.width, req.height), PILImage.LANCZOS)
                # LongCat Image Edit takes the source image directly and
                # applies an instruction-guided edit; it has no img2img
                # strength parameter in its official pipeline API.
                kwargs["image"] = init_img
                kwargs["guidance_scale"] = guidance
                kwargs["num_images_per_prompt"] = 1
                # LongCat's pipeline does not expose Diffusers' generic
                # callback_on_step_end hook.
                kwargs.pop("callback_on_step_end", None)
                with torch.inference_mode():
                    result = _pipeline(**kwargs)
                image = result.images[0]
                elapsed_ms = int((time.time() - t0) * 1000)
                with _generation_lock:
                    _generation_progress = None
                ts = int(time.time() * 1000)
                filename = f"aura-img-{ts}-seed{seed}.png"
                out_path = Path(OUTPUT_DIR) / filename
                image.save(str(out_path))
                buf = io.BytesIO()
                image.save(buf, format="PNG")
                b64 = base64.b64encode(buf.getvalue()).decode()
                return GenerateResponse(
                    image_b64=b64,
                    seed=seed,
                    elapsed_ms=elapsed_ms,
                    filename=filename,
                )
            from diffusers import (
                FluxImg2ImgPipeline,
                StableDiffusionXLImg2ImgPipeline,
                StableDiffusion3Img2ImgPipeline,
                AutoPipelineForImage2Image,
                ZImageImg2ImgPipeline,
            )
            import math
            _img2img_cls_map = {
                "FluxPipeline":              FluxImg2ImgPipeline,
                "StableDiffusionXLPipeline": StableDiffusionXLImg2ImgPipeline,
                "StableDiffusion3Pipeline":  StableDiffusion3Img2ImgPipeline,
                "AutoPipelineForText2Image": AutoPipelineForImage2Image,
                "ZImagePipeline":            ZImageImg2ImgPipeline,
            }
            Img2ImgCls = _img2img_cls_map.get(pipeline_class)
            if Img2ImgCls is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Image-to-image is not supported for model '{req.model}'"
                )

            # Guard: floor(steps × strength) must be ≥ 1 or the pipeline gets
            # 0 timesteps and raises "cannot reshape tensor of 0 elements".
            # This bites SDXL-Turbo (default 1 step) whenever strength < 1.0.
            min_steps_for_strength = math.ceil(1.0 / max(req.strength, 1e-6))
            if steps < min_steps_for_strength:
                steps = min_steps_for_strength
                kwargs["num_inference_steps"] = steps

            img_bytes = base64.b64decode(req.init_image)
            init_img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
            # Resize to requested output dimensions so the pipeline doesn't complain
            init_img = init_img.resize((req.width, req.height), PILImage.LANCZOS)

            img2img_pipe = Img2ImgCls.from_pipe(_pipeline)
            kwargs["image"] = init_img
            kwargs["strength"] = req.strength
            # img2img pipelines derive output size from the input image — no width/height kwarg
            with torch.inference_mode():
                result = img2img_pipe(**kwargs)
        else:
            # ── Text-to-image (original path) ─────────────────────────────────
            kwargs["width"] = req.width
            kwargs["height"] = req.height
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
