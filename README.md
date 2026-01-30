# logintemplate

Minimal React + Express starter that implements Google Sign-In with HTTP-only session cookies.

## Quick start
1. Copy `.env.example` to `.env` and fill in `GOOGLE_CLIENT_ID` + `AUTH_SESSION_SECRET`.
2. Install dependencies:
   - `npm install`
3. Run the server: `npm run dev`
4. Run the client: `npm run client:dev`

The client runs on `http://localhost:5173` and proxies `/api` to the Express server on `http://localhost:3000`.
