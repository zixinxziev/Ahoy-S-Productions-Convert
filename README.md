AHOY'S PRODUCTIONS — Audio Converter + Universal Downloader
This project contains the existing AHOY frontend and Node.js backend, plus a dedicated Python downloader service.
Project layout
`frontend/` — existing AHOY website and workspaces.
`backend/` — existing Express API, auth, membership, converter, split, Roblox features, and secure downloader gateway.
`downloader-service/` — isolated yt-dlp + FFmpeg extraction service.
`database/supabase-schema.sql` — existing database schema plus Universal Downloader quota/reservation tables and RPC.
Required deployment order
1. Apply the Supabase schema
Open Supabase SQL Editor and run the updated `database/supabase-schema.sql`.
This creates the `downloader_jobs` table and the atomic `reserve_downloader_job()` function. Existing tables are created with `IF NOT EXISTS`.
2. Deploy the dedicated downloader service
Deploy a new Docker Web Service from this same repository:
Root directory: `downloader-service`
Runtime: Docker
Environment variable: `AHOY_DOWNLOADER_SECRET` = a long random secret.
Optional: `MAX_DOWNLOAD_BYTES=262144000` (250 MB), `JOB_TTL_SECONDS=7200`.
Verify `https://YOUR-DOWNLOADER-SERVICE/health`.
Keep this service private at the application level: internal job routes require the shared secret. Do not expose the secret in the frontend.
3. Update the existing Node backend
Keep the current backend deployment and replace its source with this project version:
Root directory: `backend`
Build command: `npm install`
Start command: `npm start`
Add all variables from `backend/.env.example`.
Set `DOWNLOADER_SERVICE_URL` to the deployed downloader service base URL.
Set `DOWNLOADER_SERVICE_SECRET` to the exact same value as `AHOY_DOWNLOADER_SECRET`.
Keep the existing Supabase and JWT settings unchanged.
Set `CORS_ORIGIN` to the actual AHOY frontend origin.
4. Replace the frontend
Publish the contents of `frontend/` to the same frontend hosting location as the current AHOY website. Keep the API base URL configuration in `frontend/js/app.js` pointing at the existing Node backend.
Downloader behavior
Accepts single media URLs supported by yt-dlp, including compatible direct media links.
Output: MP3, WAV, M4A, OPUS, or Original Audio.
FFmpeg performs audio extraction/conversion.
FREE: 10 successfully transferred downloads per UTC day; one active job at a time.
UNLIMITED: no daily download quota; up to three active jobs at a time.
Failed extraction jobs do not consume daily quota.
A job is counted as successful after its file response is transferred by the Node backend.
Jobs/files are temporary. Downloader service restart can interrupt active jobs; expired jobs must be retried.
Playlist URLs are intentionally not enabled in this version.
Content must be owned by the user or authorized for download. No DRM, paywall, login-wall, or access-control bypass.
Important production notes
The dedicated service is configured for one instance because its queue/job state is in memory and its disk is temporary. Do not scale horizontally without adding Redis-backed queue/state and shared object storage.
Configure outbound firewall rules to block private, loopback, link-local, and cloud metadata IP ranges. URL validation is performed, but platform extractors may request secondary media URLs.
Respect source platform terms, copyright, and rate limits.
The current project still needs real deployment credentials and an end-to-end test against your hosting provider before it can be considered production-live.
