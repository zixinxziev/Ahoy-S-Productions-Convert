# AHOY'S AUDIO CONVERTER

Premium audio conversion project with bilingual UI (Indonesian/English), Dark Luxury Gold theme, multi-file bulk processing, Roblox target playback speed, audio preview, and Free/Unlimited membership.

## Project layout
- `frontend/` static site (GitHub Pages / Cloudflare Pages)
- `backend/` Node.js + Express + FFmpeg API
- `database/supabase-schema.sql` database schema

## Requirements
- Node.js 20+
- Supabase project
- Backend host that supports Node.js and FFmpeg binary
- Static frontend host

## Local setup
1. Create a Supabase project and run `database/supabase-schema.sql` in SQL Editor.
2. `cd backend && npm install`
3. Copy `backend/.env.example` to `backend/.env` and fill credentials.
4. Start API: `npm start`
5. Serve `frontend/` with a static server. Set `window.AHOY_API_URL` to your API URL before `app.js` loads, or replace the `API` default in `frontend/js/app.js`.

## Membership
- Free: 10 completed conversions/day. Each file in a bulk job counts as one.
- Unlimited: permanent until manually changed by an admin.
- New registrations start as Free.
- Register the owner account, then set `is_admin=true` for that username in Supabase SQL Editor.
- Admin API can list users and change membership.

## Important
This is a starter implementation, not a fully audited production service. Configure secrets, CORS, storage cleanup, monitoring, backups, privacy notice, and robust anonymous-user quota controls before public launch. Anonymous Free quotas use an IP + user-agent hash and are not guaranteed bypass-proof. For stronger anonymous controls, add privacy-conscious device tokens and IP rate limiting. Batch currently processes sequentially. Files are stored temporarily on the backend host.
