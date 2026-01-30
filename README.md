# logintemplate

Minimal React + Flask starter that implements Google Sign-In with HTTP-only session cookies.

## Quick start
1. Copy `.env.example` to `.env` and fill in `GOOGLE_CLIENT_ID` + `AUTH_SESSION_SECRET`.
2. Install Python deps:
   - `pip install -r requirements.txt`
3. Install client deps:
   - `npm install`
4. Run the API server:
   - `python server/app.py`
5. Run the client:
   - `npm run client:dev`

The client runs on `http://localhost:5173` and proxies `/api` to the Flask server on
`http://localhost:3000` via `client/vite.config.js`.
