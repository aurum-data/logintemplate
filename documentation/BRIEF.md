# Login Template Engineering Brief

## Overview
This repo is a minimal React + Flask app that implements Google Sign-In (Google Identity Services) and stores an authenticated session in a signed HTTP-only cookie. It is meant as a clean starting point for any app that needs Google authentication before hitting protected API routes.

## Repository Layout
- `server/app.py` - Flask API, session signing, Google ID token verification, and static file hosting.
- `client/` - Vite + React SPA with a simple login UI.
- `.env.example` - Environment variables you need to run the app.
- `requirements.txt` - Python dependencies for the Flask server.
- `documentation/BRIEF.md` - This document.

## How Authentication Works
1. The client loads the Google Identity Services script (`https://accounts.google.com/gsi/client`).
2. Clicking "Sign in with Google" opens the Google popup. Google returns an **ID token** (credential).
3. The client posts the ID token to `POST /api/auth/google`.
4. The server verifies the ID token using `google-auth` and the configured `GOOGLE_CLIENT_ID`.
5. On success, the server creates a signed session token and sets it in the `lt_auth` cookie.
6. The client checks session state via `GET /api/auth/me` and uses `credentials: 'include'` on protected calls.

### Session Token Format
The session token is a simple HMAC-signed payload:
- Body: JSON `{ sub, email, name, picture, iss, exp }`.
- Signature: `HMAC-SHA256(SESSION_SECRET, body)`.
- Stored as `base64url(body) + '.' + base64url(signature)`.

This keeps the cookie self-contained and server verification is just signature + expiry checks. The cookie
is `HttpOnly`, `SameSite=Lax`, and marked `Secure` in production.

## API Endpoints
- `GET /health` - Liveness probe.
- `GET /api/auth/config` - Returns `{ googleAuthConfigured, googleClientId, sessionTtlMs }` for the client.
- `POST /api/auth/google` - Verifies Google ID token, sets session cookie, returns `{ authenticated, user }`.
- `GET /api/auth/me` - Reads the session cookie and returns `{ authenticated, user, expiresAt }`.
- `POST /api/auth/logout` - Clears the session cookie.
- `GET /api/secret` - Example protected endpoint using `require_auth`.
- `GET /api/subscription/config` - Returns PayPal + subscription display config.
- `POST /api/subscription/verify` - Validates a PayPal subscription ID and records the signup.
- `GET /api/admin/config` - Returns `{ authenticated, isAdmin, paypalConfigured }`.
- `GET /api/admin/plans` - Lists PayPal plans created via the admin UI.
- `POST /api/admin/plans/create` - Creates a PayPal product + plan and stores it.

## Environment Variables
Required:
- `GOOGLE_CLIENT_ID` - Google OAuth Web Client ID.
- `AUTH_SESSION_SECRET` - Secret used to sign session cookies (use a long random string).

Optional:
- `VITE_GOOGLE_CLIENT_ID` - Client-side fallback if you want Vite to inject the ID directly.
- `AUTH_SESSION_TTL_MS` - Session lifetime in ms (default 7 days).
- `CORS_ORIGIN` / `CORS_ORIGINS` - Comma-separated list of allowed origins.
- `COOKIE_SECURE` - Force Secure cookies (`true`), otherwise `NODE_ENV=production` enables it.
- `PAYPAL_CLIENT_ID` - PayPal REST client ID (required for Subscription page).
- `PAYPAL_CLIENT_SECRET` - PayPal REST client secret.
- `PAYPAL_PLAN_ID` - PayPal subscription plan ID.
- `PAYPAL_ENV` - `sandbox` or `live` (default `sandbox`).
- `SUBSCRIPTION_NAME` - Display name for the subscription plan.
- `SUBSCRIPTION_PRICE` - Display price for the subscription plan.
- `SUBSCRIPTION_CURRENCY` - Display currency (default `USD`).
- `ADMIN_EMAILS` - Comma-separated list of admin email addresses allowed to access admin tooling.
- `DATABASE_URL` - Postgres connection string for subscription signups.
- `SUBSCRIPTIONS_DB_PATH` - SQLite file path fallback when `DATABASE_URL` is not set.

Notes:
- `GOOGLE_CLIENT_ID` must be configured with the exact JavaScript origins you will use (local + production).
- `requests` is required by `google-auth`'s transport and is included in `requirements.txt`.

## Local Development
1. `pip install -r requirements.txt`
2. Copy `.env.example` to `.env` and fill out the required variables.
3. Run the server: `python server/app.py` (http://localhost:3000).
4. Run the client: `npm install` then `npm run client:dev` (http://localhost:5173).

The Vite dev server proxies `/api` to the Flask server via `client/vite.config.js`.

## Production Build
- Run `npm run build` to create `client/dist`.
- The Flask server serves `client/dist` automatically if it exists.

## Render Deployment (Web Service)
- Build command:
  - `pip install -r requirements.txt && npm --prefix client install --include=dev && npm --prefix client run build`
- Start command:
  - `gunicorn --bind 0.0.0.0:$PORT server.app:app`
- Render injects `PORT` automatically.

Environment variables to set on Render:
- `GOOGLE_CLIENT_ID`
- `AUTH_SESSION_SECRET`
- Optional: `COOKIE_SECURE=true`, `NODE_ENV=production`, `CORS_ORIGINS=https://your-app.onrender.com`

## Troubleshooting
- **GSI_LOGGER: The given origin is not allowed** or `gsi/status 403`: add the current origin to the OAuth client
  in Google Cloud Console under "Authorized JavaScript origins", then wait a few minutes for propagation.

## How to Extend This Template
- Add new protected endpoints: wrap with `@require_auth` and use `g.user`.
- Store users in a database: insert in the `/api/auth/google` handler after verification.
- Swap Google auth: keep the session cookie model and replace the ID token verification.
- Add roles/permissions: include role claims in the session payload and check them in middleware.

## Key Things to Remember
- `AUTH_SESSION_SECRET` is required; without it, login will fail.
- Always include `credentials: 'include'` in client fetch calls that need cookies.
- Make sure your Google OAuth client allows the correct authorized origins and redirect URIs for both local and prod.
