# logintemplate

Minimal React + Flask starter that implements Google Sign-In with HTTP-only session cookies.

## Clone + run locally
1. Clone the repo:
   - `git clone https://github.com/aurum-data/logintemplate.git`
   - `cd logintemplate`
2. Copy `.env.example` to `.env` and fill in `GOOGLE_CLIENT_ID` + `AUTH_SESSION_SECRET`.
3. Install Python deps:
   - `pip install -r requirements.txt`
4. Install client deps:
   - `npm install`
5. Run the API server:
   - `python server/app.py`
6. Run the client:
   - `npm run client:dev`

The client runs on `http://localhost:5173` and proxies `/api` to the Flask server on
`http://localhost:3000` via `client/vite.config.js`.

## Google OAuth setup
In Google Cloud Console (OAuth 2.0 Client ID, Web app), add your exact origins:
- Local: `http://localhost:5173`
- Production: `https://your-app.onrender.com` (and any custom domain)

## Render deployment (Web Service)
Build command:
```
pip install -r requirements.txt && npm --prefix client install --include=dev && npm --prefix client run build
```

Start command:
```
gunicorn --bind 0.0.0.0:$PORT server.app:app
```

Environment variables (Render):
- `GOOGLE_CLIENT_ID`
- `AUTH_SESSION_SECRET`
- Optional: `COOKIE_SECURE=true`, `NODE_ENV=production`, `CORS_ORIGINS=https://your-app.onrender.com`
