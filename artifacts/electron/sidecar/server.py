"""
Aura Farming — Local Image Generation Sidecar
FastAPI server that wraps local Stable Diffusion checkpoints for GPU-accelerated
image generation. Model weights are downloaded directly from Civitai without
Hugging Face model repositories or paid API credits.
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
import subprocess
import urllib.error
import urllib.request
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
_loading_progress: Optional[dict] = None
_load_lock = threading.Lock()
_loading_progress_lock = threading.Lock()
_gpu_info_cache: Optional[dict] = None
_generation_progress: Optional[dict] = None
_generation_lock = threading.Lock()


def _model_path(model_key: str) -> Optional[Path]:
    info = MODELS.get(model_key)
    if not info:
        return None
    return Path(MODELS_DIR) / str(info["filename"])


def _model_is_cached(model_key: str) -> bool:
    """Return True when a complete direct-download checkpoint is on disk."""
    if model_key not in MODELS:
        return False
    model_path = _model_path(model_key)
    if not model_path or not model_path.exists():
        return False
    expected = int(MODELS[model_key]["size_bytes"])
    return model_path.stat().st_size >= int(expected * 0.99)


def _scan_model_cache_progress(model_key: str) -> tuple[int, int, int]:
    """Return (bytes on disk, completed files, active files) for one checkpoint."""
    model_path = _model_path(model_key)
    if not model_path:
        return 0, 0, 0
    partial_path = model_path.with_suffix(model_path.suffix + ".part")
    downloaded_bytes = 0
    completed_files = 0
    active_files = 0
    try:
        if model_path.exists() and model_path.is_file():
            downloaded_bytes += model_path.stat().st_size
            completed_files = 1
        if partial_path.exists() and partial_path.is_file():
            downloaded_bytes += partial_path.stat().st_size
            active_files = 1
    except OSError:
        pass
    return downloaded_bytes, completed_files, active_files


def _set_loading_progress(model_key: str, *, phase: Optional[str] = None) -> None:
    """Refresh download progress from the local Civitai checkpoint files."""
    global _loading_progress
    downloaded_bytes, completed_files, active_files = _scan_model_cache_progress(model_key)
    now = time.monotonic()
    with _loading_progress_lock:
        current = _loading_progress or {}
        previous_bytes = int(current.get("downloaded_bytes", 0))
        previous_at = float(current.get("_sampled_at", now))
        elapsed = max(now - previous_at, 0.001)
        instantaneous_speed = max(0.0, (downloaded_bytes - previous_bytes) / elapsed)
        previous_speed = float(current.get("speed_bytes_per_second", 0.0))
        # Smooth the display without hiding a stopped transfer: new samples
        # contribute quickly, while a zero sample naturally decays to zero.
        speed = instantaneous_speed if previous_speed <= 0 else (previous_speed * 0.65) + (instantaneous_speed * 0.35)
        total_bytes = int(current.get("total_bytes", 0))
        remaining = max(total_bytes - downloaded_bytes, 0)
        eta = round(remaining / speed) if speed > 1024 and remaining > 0 else None
        percent = round(min(downloaded_bytes / total_bytes * 100, 100), 1) if total_bytes > 0 else None
        _loading_progress = {
            "phase": phase or current.get("phase") or "downloading",
            "downloaded_bytes": downloaded_bytes,
            "total_bytes": total_bytes,
            "percent": percent,
            "speed_bytes_per_second": round(speed),
            "eta_seconds": eta,
            "completed_files": completed_files,
            "active_files": active_files,
            "total_files": int(current.get("total_files", 0)),
            "total_source": current.get("total_source", "Civitai direct download"),
            "total_is_estimate": bool(current.get("total_is_estimate", True)),
            # Internal sampling timestamp; removed before returning status.
            "_sampled_at": now,
        }


def _start_loading_progress(model_key: str, cached: bool) -> None:
    """Initialize progress using the known size of the direct checkpoint file."""
    global _loading_progress
    total_bytes = int(MODELS[model_key]["size_bytes"])
    with _loading_progress_lock:
        _loading_progress = {
            "phase": "loading_pipeline" if cached else "downloading",
            "downloaded_bytes": 0,
            "total_bytes": total_bytes,
            "percent": 0,
            "speed_bytes_per_second": 0,
            "eta_seconds": None,
            "completed_files": 0,
            "active_files": 0,
            "total_files": 1,
            "total_source": "Civitai direct download",
            "total_is_estimate": False,
            "_sampled_at": time.monotonic(),
        }
    _set_loading_progress(model_key, phase="loading_pipeline" if cached else "downloading")


def _download_model_file(model_key: str) -> Path:
    """Resume a public Civitai checkpoint download without using the Hub."""
    info = MODELS[model_key]
    model_path = _model_path(model_key)
    if model_path is None:
        raise RuntimeError(f"No local path configured for {model_key}")
    if _model_is_cached(model_key):
        return model_path

    partial_path = model_path.with_suffix(model_path.suffix + ".part")
    expected_bytes = int(info["size_bytes"])
    existing_bytes = partial_path.stat().st_size if partial_path.exists() else 0
    headers = {
        "User-Agent": "AuraFarming/1.2 local image model downloader",
        "Accept": "application/octet-stream",
    }
    if existing_bytes > 0:
        headers["Range"] = f"bytes={existing_bytes}-"

    request = urllib.request.Request(str(info["download_url"]), headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=90)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Civitai download could not start ({exc.code}): {exc.reason}") from exc
    except Exception as exc:
        raise RuntimeError(f"Civitai download could not start: {exc}") from exc

    response_status = getattr(response, "status", 200)
    if existing_bytes > 0 and response_status != 206:
        # The CDN declined resume. Restart the partial file rather than
        # appending a second copy of the checkpoint.
        existing_bytes = 0
    mode = "ab" if existing_bytes > 0 else "wb"
    downloaded_bytes = existing_bytes
    try:
        with response, partial_path.open(mode) as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                downloaded_bytes += len(chunk)
                _set_loading_progress(model_key, phase="downloading")
    except Exception as exc:
        raise RuntimeError(
            f"Civitai download interrupted after {downloaded_bytes / (1024 ** 3):.2f} GB. "
            "Press Load Model again to resume."
        ) from exc

    if downloaded_bytes < int(expected_bytes * 0.99):
        raise RuntimeError(
            f"Civitai returned an incomplete checkpoint ({downloaded_bytes} of {expected_bytes} bytes). "
            "Press Load Model again to resume."
        )
    partial_path.replace(model_path)
    _set_loading_progress(model_key, phase="loading_pipeline")
    return model_path


def _public_loading_progress() -> Optional[dict]:
    with _loading_progress_lock:
        if not _loading_progress:
            return None
        return {key: value for key, value in _loading_progress.items() if not key.startswith("_")}


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
    "realistic-vision-v6": {
        "label": "Realistic Vision V6 (free local, ~2 GB)",
        "filename": "realisticVisionV60B1_v60B1VAE.safetensors",
        "download_url": "https://civitai.com/api/download/models/245598",
        "size_bytes": 2132625894,
        "size_gb": 2,
        "config_dir": "sd15-config",
        "default_steps": 30,
        "default_guidance": 7.0,
        "supports_reference_image": True,
        "requires_reference_image": True,
        "use_cpu_offload": True,
    },
    "epicrealism-natural-sin": {
        "label": "epiCRealism Natural Sin (free local, ~2 GB)",
        "filename": "epicrealism_naturalSinRC1VAE.safetensors",
        "download_url": "https://civitai.com/api/download/models/143906",
        "size_bytes": 2132625612,
        "size_gb": 2,
        "config_dir": "sd15-config",
        "default_steps": 30,
        "default_guidance": 7.0,
        "supports_reference_image": True,
        "requires_reference_image": True,
        "use_cpu_offload": True,
    },
}

# ── Request / response models ─────────────────────────────────────────────────
class CpuThreadsRequest(BaseModel):
    threads: int

class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str = ""
    model: str = "realistic-vision-v6"
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
    model: str = "realistic-vision-v6"

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
    global _loading_from_cache, _loading_phase, _loading_started_at, _loading_detail, _loading_progress

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
    _start_loading_progress(model_key, cached)
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
        model_path = _download_model_file(model_key)
        log.info(f"Local Civitai checkpoint ready: {model_path}")

        import torch

        # Detect the best available device, but do not reject the model here.
        # The previous version turned this into a hard CUDA/VRAM gate, which
        # prevented machines from attempting the slower CPU fallback.
        _loading_phase = "hardware_check"
        _status_message = "Selecting the best available processing device…"
        _loading_detail = "CUDA will be used when available; otherwise loading on the CPU…"
        _set_loading_progress(model_key, phase="hardware_check")
        gpu_info = _get_gpu_info()
        device = "cuda" if gpu_info["available"] else "cpu"
        if device == "cpu":
            _loading_detail = (
                "No usable Torch CUDA runtime detected; loading on the CPU. "
                "This can be slow and use substantial system RAM."
            )

        from diffusers import StableDiffusionImg2ImgPipeline
        from transformers import CLIPTokenizer
        PipelineCls = StableDiffusionImg2ImgPipeline

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
        config_dir = Path(__file__).resolve().parent / str(info["config_dir"])
        tokenizer = CLIPTokenizer.from_pretrained(
            str(config_dir / "tokenizer"),
            local_files_only=True,
        )

        if _loading_from_cache:
            _loading_phase = "loading_pipeline"
            _loading_detail = "Assembling the cached model components…"
            _set_loading_progress(model_key, phase="loading_pipeline")
        else:
            # The direct Civitai download has already completed above. Keep
            # this phase separate so the UI never confuses model assembly with
            # network transfer.
            _loading_phase = "loading_pipeline"
            _loading_detail = "Preparing the local checkpoint…"
            _set_loading_progress(model_key, phase="loading_pipeline")
        log.info(f"Loading local checkpoint for {model_key} (elapsed {time.time() - _loading_started_at:.0f}s)")
        pipe = PipelineCls.from_single_file(
            str(model_path),
            config=str(config_dir),
            tokenizer=tokenizer,
            safety_checker=None,
            feature_extractor=None,
            torch_dtype=dtype,
            local_files_only=True,
            low_cpu_mem_usage=True,
        )
        log.info(
            f"Local pipeline assembled for {model_key} "
            f"(elapsed {time.time() - _loading_started_at:.0f}s); moving to {device.upper()}"
        )

        _loading_phase = "loading_pipeline"
        _loading_detail = "Assembling model components; diffusers does not expose percentage progress here…"
        _set_loading_progress(model_key, phase="loading_pipeline")
        _loading_phase = "moving_to_device"
        _loading_detail = f"Moving the assembled pipeline to {device.upper()} memory…"
        _set_loading_progress(model_key, phase="moving_to_device")
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
        with _loading_progress_lock:
            _loading_progress = None
        _status = "ready"
        _status_message = f"Ready — {info['label']} on {device.upper()}"
        log.info(_status_message)

    except Exception as exc:
        _loading_model_key = None
        _loading_from_cache = False
        _loading_phase = "error"
        _loading_started_at = None
        _loading_detail = ""
        with _loading_progress_lock:
            _loading_progress = None
        _status = "error"
        _status_message = str(exc)
        log.error(f"Failed to load model: {exc}")


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/status")
def get_status():
    if _status == "loading" and _loading_model_key and _loading_phase == "downloading":
        _set_loading_progress(_loading_model_key, phase="downloading")
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
        "loading_progress": _public_loading_progress(),
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
    global _loading_started_at, _loading_detail, _loading_progress
    import gc
    _pipeline = None
    _loaded_model = None
    _loading_phase = "idle"
    _loading_started_at = None
    _loading_detail = ""
    with _loading_progress_lock:
        _loading_progress = None
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
    """Delete one registered model's local Civitai checkpoint from disk."""
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

    freed_bytes = 0
    for model_path in filter(None, (_model_path(req.model),)):
        partial_path = model_path.with_suffix(model_path.suffix + ".part")
        for file_path in (model_path, partial_path):
            try:
                if file_path.exists():
                    freed_bytes += file_path.stat().st_size
                    file_path.unlink()
            except OSError:
                pass

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

        # Both supported models are local Stable Diffusion reference-image
        # editors. Keep this path deliberately small: one image input and one
        # pipeline call, with no remote model or adapter downloads.
        from PIL import Image as PILImage
        img_bytes = base64.b64decode(req.init_image)
        init_img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
        init_img = init_img.resize((req.width, req.height), PILImage.LANCZOS)
        kwargs["image"] = init_img
        kwargs["strength"] = max(0.0, min(req.strength, 1.0))
        kwargs["num_images_per_prompt"] = 1
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
