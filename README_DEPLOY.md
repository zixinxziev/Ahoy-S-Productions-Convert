AHOY deployment checklist
Supabase
Open SQL Editor.
Run the complete updated `database/supabase-schema.sql`.
Confirm `public.downloader_jobs` and `public.reserve_downloader_job(text)` exist.
Dedicated Downloader Service
Create a new Docker Web Service from the same Git repository.
Root Directory: `downloader-service`.
Set `AHOY_DOWNLOADER_SECRET` to a long random secret.
Optional: set `MAX_DOWNLOAD_BYTES=262144000` and `JOB_TTL_SECONDS=7200`.
Deploy and verify `/health`.
Existing Node Backend
Replace the backend source with `backend/` from this project.
Build: `npm install`; Start: `npm start`.
Preserve current `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `JWT_SECRET`.
Set `DOWNLOADER_SERVICE_URL` to the dedicated service URL.
Set `DOWNLOADER_SERVICE_SECRET` to the exact same value as `AHOY_DOWNLOADER_SECRET`.
Keep `CORS_ORIGIN` restricted to the real AHOY frontend domain.
Verify `/health`.
Frontend
Replace the hosted website files with the contents of `frontend/`.
Confirm `API` in `frontend/js/app.js` still points to the current Node backend.
Log in with an AHOY account and open `#ahoyDownloaderWorkspace`.
Test
Test one permitted public single-media URL from a platform supported by yt-dlp.
Test MP3 and Original Audio.
Confirm FREE usage increments only after the file is delivered.
Confirm failed jobs do not increment usage.
Confirm an UNLIMITED account is not daily-limited.
Confirm a FREE account can run one job and UNLIMITED can run up to three jobs concurrently.
Test existing Convert, Split, Roblox Upload, and Roblox History features.
Important
The dedicated downloader service uses temporary in-memory jobs and local ephemeral files. Keep one service instance. Add Redis and object storage before horizontal scaling or if durable jobs are required.
