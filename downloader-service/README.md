# AHOY Universal Downloader Service

Dedicated Python service for media URLs supported by yt-dlp, with FFmpeg audio extraction.

## Deploy (Render / Docker host)
- Create a new **Web Service** from this repository.
- Set **Root Directory** to `downloader-service`.
- Choose **Docker** runtime.
- Add environment variable `AHOY_DOWNLOADER_SECRET` with a long random value.
- Optional: `MAX_DOWNLOAD_BYTES=262144000` (250 MB) and `JOB_TTL_SECONDS=7200`.
- Deploy, then verify `/health`.

Use the exact same secret in the main Node backend as `DOWNLOADER_SERVICE_SECRET`, and set `DOWNLOADER_SERVICE_URL` to this service's public base URL. The internal endpoints require the shared secret.

## Notes
- One service process is intentionally used because jobs are held in memory. Deploy as a single instance unless a persistent queue/database is added.
- Files are temporary and expire after the configured job TTL; the host's ephemeral disk is used.
- Supports single media URLs handled by yt-dlp. Playlist URLs are intentionally rejected in this version.
- Only content that the user owns or is authorized to download. No DRM, paywall, login-wall, or access-control bypass.
- Public URL validation is performed before extraction. For production, add outbound network firewall rules blocking private, loopback, link-local, and cloud metadata ranges because extractors may request secondary media URLs.
- Respect each source platform's terms, copyright rules, and rate limits.
