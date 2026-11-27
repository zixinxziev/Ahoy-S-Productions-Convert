import asyncio
import ipaddress
import os
import re
import secrets
import shutil
import socket
import tempfile
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from yt_dlp import YoutubeDL

APP_SECRET = os.environ.get("AHOY_DOWNLOADER_SECRET", "")
MAX_FILE_BYTES = int(os.environ.get("MAX_DOWNLOAD_BYTES", str(250 * 1024 * 1024)))
JOB_TTL_SECONDS = int(os.environ.get("JOB_TTL_SECONDS", "7200"))
JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
OUTPUT_ROOT = Path(os.environ.get("DOWNLOAD_DIR", "/tmp/ahoy-downloader"))
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="AHOY Universal Downloader", version="1.0.0")


class CreateJob(BaseModel):
    job_id: str = Field(min_length=20, max_length=64)
    url: str = Field(min_length=8, max_length=2048)
    format: str = Field(default="mp3", pattern="^(mp3|wav|m4a|opus|original)$")


def require_internal_key(value: str | None):
    if not APP_SECRET:
        raise HTTPException(status_code=503, detail="Downloader service secret is not configured.")
    if not value or not secrets.compare_digest(value, APP_SECRET):
        raise HTTPException(status_code=401, detail="Unauthorized service request.")


def validate_public_url(raw: str):
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="Only public HTTP/HTTPS media URLs are accepted.")
    host = parsed.hostname.lower().rstrip(".")
    if host in {"localhost", "metadata", "metadata.google.internal", "host.docker.internal"} or host.endswith(".local"):
        raise HTTPException(status_code=400, detail="Private or local hosts are not allowed.")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)}
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="The media host could not be resolved.")
    if not addresses:
        raise HTTPException(status_code=400, detail="The media host could not be resolved.")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise HTTPException(status_code=400, detail="Private or reserved network addresses are not allowed.")
    return parsed


def safe_filename(value: str) -> str:
    value = re.sub(r'[\x00-\x1f<>:"/\\|?*]', "_", value or "ahoy-audio")
    value = re.sub(r"\s+", " ", value).strip(" .")
    return (value[:150] or "ahoy-audio")


def run_download(job_id: str, url: str, output_format: str):
    job_dir = OUTPUT_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    state = JOBS[job_id]
    state.update(status="extracting", progress=0, error="", title="", extractor="")
    try:
        def progress_hook(data):
            if data.get("status") == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
                downloaded = data.get("downloaded_bytes") or 0
                if downloaded > MAX_FILE_BYTES:
                    raise RuntimeError("The downloaded file exceeds the configured size limit.")
                pct = min(95, int(downloaded * 100 / total)) if total else 0
                state.update(status="downloading", progress=pct)
            elif data.get("status") == "finished":
                state.update(status="processing", progress=max(95, state.get("progress", 0)))

        def postprocessor_hook(data):
            if data.get("status") == "started":
                state.update(status="processing", progress=97)
            elif data.get("status") == "finished":
                state.update(status="processing", progress=99)

        options = {
            "format": "bestaudio/best",
            "outtmpl": str(job_dir / "%(id)s.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "no_color": True,
            "restrictfilenames": True,
            "socket_timeout": 25,
            "retries": 2,
            "fragment_retries": 2,
            "extractor_retries": 2,
            "file_access_retries": 1,
            "max_filesize": MAX_FILE_BYTES,
            "progress_hooks": [progress_hook],
            "postprocessor_hooks": [postprocessor_hook],
            "overwrites": True,
            "continuedl": False,
        }
        if output_format != "original":
            options["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": output_format,
                "preferredquality": "192" if output_format == "mp3" else "0",
            }]

        state.update(status="extracting", progress=0)
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                raise RuntimeError("The platform did not return media information.")
            if info.get("_type") in ("playlist", "multi_video"):
                raise RuntimeError("Playlist URLs are not enabled in this version. Please use a single track or video URL.")
            title = safe_filename(info.get("title") or "ahoy-audio")
            extractor = str(info.get("extractor_key") or info.get("extractor") or "media")[:80]
            state.update(title=title, extractor=extractor, status="downloading", progress=0)
            ydl.download([url])

        candidates = [p for p in job_dir.iterdir() if p.is_file() and not p.name.endswith((".part", ".ytdl"))]
        if not candidates:
            raise RuntimeError("The extractor completed without producing a media file.")
        output = max(candidates, key=lambda p: p.stat().st_size)
        if output.stat().st_size > MAX_FILE_BYTES:
            raise RuntimeError("The downloaded file exceeds the configured size limit.")
        display_name = safe_filename(title) + output.suffix.lower()
        state.update(
            status="completed",
            progress=100,
            filename=display_name,
            file_path=str(output),
            error="",
            completed_at=time.time(),
        )
    except Exception as exc:
        message = str(exc).strip() or "Download failed."
        if len(message) > 450:
            message = message[:450]
        state.update(status="failed", progress=0, error=message, completed_at=time.time())
        shutil.rmtree(job_dir, ignore_errors=True)


@app.get("/health")
def health():
    import yt_dlp

    return {
        "ok": True,
        "service": "AHOY Universal Downloader",
        "engine": "yt-dlp + FFmpeg",
        "yt_dlp_version": yt_dlp.version.__version__
    }

@app.post("/internal/jobs", status_code=202)
async def create_job(payload: CreateJob, x_ahoy_service_key: str | None = Header(default=None)):
    require_internal_key(x_ahoy_service_key)
    validate_public_url(payload.url)
    now = time.time()
    with JOBS_LOCK:
        expired = [key for key, value in JOBS.items() if now - value.get("created_at", now) > JOB_TTL_SECONDS]
        for key in expired:
            JOBS.pop(key, None)
            shutil.rmtree(OUTPUT_ROOT / key, ignore_errors=True)
        if payload.job_id in JOBS:
            return {"job_id": payload.job_id, "status": JOBS[payload.job_id]["status"]}
        JOBS[payload.job_id] = {
            "status": "queued",
            "progress": 0,
            "created_at": now,
            "title": "",
            "extractor": "",
            "filename": "",
            "file_path": "",
            "error": "",
        }
    asyncio.create_task(asyncio.to_thread(run_download, payload.job_id, payload.url, payload.format))
    return {"job_id": payload.job_id, "status": "queued"}


@app.get("/internal/jobs/{job_id}")
def get_job(job_id: str, x_ahoy_service_key: str | None = Header(default=None)):
    require_internal_key(x_ahoy_service_key)
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job expired or not found. Please start a new download.")
    return {
        "job_id": job_id,
        "status": job.get("status"),
        "progress": job.get("progress", 0),
        "title": job.get("title", ""),
        "extractor": job.get("extractor", ""),
        "filename": job.get("filename", ""),
        "error": job.get("error", ""),
    }


@app.get("/internal/jobs/{job_id}/file")
def get_job_file(job_id: str, x_ahoy_service_key: str | None = Header(default=None)):
    require_internal_key(x_ahoy_service_key)
    job = JOBS.get(job_id)
    if not job or job.get("status") != "completed":
        raise HTTPException(status_code=404, detail="Download file is not ready.")
    file_path = Path(job.get("file_path", ""))
    if not file_path.is_file() or not file_path.resolve().is_relative_to(OUTPUT_ROOT.resolve()):
        raise HTTPException(status_code=404, detail="Download file expired.")
    return FileResponse(
        file_path,
        media_type="application/octet-stream",
        filename=job.get("filename") or file_path.name,
        headers={"Cache-Control": "no-store"},
    )
