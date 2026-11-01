# Deployment guide

## 1. Supabase
1. Create a project at Supabase.
2. Open SQL Editor and run `database/supabase-schema.sql`.
3. Copy Project URL and service-role key from Project Settings > API.
4. Never put the service-role key in frontend or public GitHub files.

## 2. Backend (Render or another Node.js host)
1. Push this repository to GitHub.
2. Create a Web Service using the repository.
3. Root directory: `backend`
4. Build command: `npm install`
5. Start command: `npm start`
6. Add environment variables from `backend/.env.example`.
7. Set `CORS_ORIGIN` to the exact frontend URL.
8. Set a long random `JWT_SECRET`.
9. Confirm `https://YOUR-API/health` returns `{ "ok": true }`.

## 3. Frontend (GitHub Pages)
1. Edit `frontend/js/app.js` and change the API constant to your backend URL.
2. Publish the `frontend` folder using GitHub Pages (or copy its contents to the Pages publishing root).
3. Set the backend `CORS_ORIGIN` to your published Pages URL.
4. Open the website and test register, login, conversion and downloads.

## 4. Activate Unlimited / Admin
1. Register normally through the website.
2. In Supabase SQL Editor, promote the owner account:
   `update public.users set is_admin=true where username='YOUR_USERNAME';`
3. Admin API endpoints require an admin JWT. A dedicated admin dashboard UI is not included in this starter; use the protected API or add a dashboard client before public release.
4. Admin activates a user with PATCH `/api/admin/users/USER_UUID/membership` and JSON `{"membership":"unlimited"}`.

## 5. Production checklist
- Replace JWT secret; configure CORS to exact origins.
- Add password reset, email/abuse protections and CAPTCHA as needed.
- Add persistent job queue, object storage, automatic temp-file cleanup and conversion retention policy.
- Add admin dashboard UI and audit logs.
- Add robust anonymous quota/device token controls and per-account quota reporting.
- Test Roblox playback speed/pitch against real Roblox uploads. Platform re-encoding can change output.
