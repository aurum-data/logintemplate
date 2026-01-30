const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');

require('dotenv').config();

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseOrigins = (raw) =>
  String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const allowedOrigins = new Set([
  ...parseOrigins(process.env.CORS_ORIGIN),
  ...parseOrigins(process.env.CORS_ORIGINS),
]);

if (!allowedOrigins.size && process.env.NODE_ENV !== 'production') {
  allowedOrigins.add('http://localhost:5173');
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }
      if (!allowedOrigins.size) {
        return callback(null, true);
      }
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin not allowed: ${origin}`));
    },
    credentials: true,
  }),
);
app.use(express.json());

const SESSION_COOKIE_NAME = 'lt_auth';
const SESSION_MAX_AGE_MS = parseNumber(process.env.AUTH_SESSION_TTL_MS, 1000 * 60 * 60 * 24 * 7);
const SESSION_SECRET =
  process.env.AUTH_SESSION_SECRET || process.env.SESSION_SECRET || process.env.COOKIE_SECRET || null;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || null;
const googleOAuthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const SESSION_ISSUER = 'logintemplate';

const parseCookies = (cookieHeader) => {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return {};
  }
  return cookieHeader.split(';').reduce((acc, part) => {
    const [rawKey, ...rest] = part.split('=');
    const key = rawKey?.trim();
    const value = rest.join('=').trim();
    if (key) {
      acc[key] = decodeURIComponent(value);
    }
    return acc;
  }, {});
};

const base64UrlEncode = (input) => Buffer.from(input).toString('base64url');
const base64UrlDecode = (input) => Buffer.from(input, 'base64url').toString('utf8');

const createSessionToken = (payload) => {
  if (!SESSION_SECRET) {
    throw new Error('Missing AUTH_SESSION_SECRET for session signing');
  }
  const exp = Date.now() + SESSION_MAX_AGE_MS;
  const sessionPayload = { ...payload, iss: SESSION_ISSUER, exp };
  const body = JSON.stringify(sessionPayload);
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${base64UrlEncode(body)}.${signature}`;
};

const verifySessionToken = (token) => {
  if (!token || !SESSION_SECRET) {
    return null;
  }
  const [bodyPart, signaturePart] = token.split('.');
  if (!bodyPart || !signaturePart) {
    return null;
  }
  const body = base64UrlDecode(bodyPart);
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const timingSafe =
    expectedSig.length === signaturePart.length &&
    crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signaturePart));
  if (!timingSafe) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed.iss !== SESSION_ISSUER || !parsed.exp || parsed.exp < Date.now()) {
    return null;
  }
  return parsed;
};

const buildSessionCookie = (token, { clear = false } = {}) => {
  const base = `${SESSION_COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`;
  const parts = [base, 'Path=/'];
  if (clear) {
    parts.push('Max-Age=0');
  } else {
    parts.push(`Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`);
  }
  const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  if (secure) {
    parts.push('Secure');
  }
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  return parts.join('; ');
};

const getSessionFromRequest = (req) => {
  const cookies = parseCookies(req.headers?.cookie ?? '');
  const token = cookies[SESSION_COOKIE_NAME];
  return verifySessionToken(token);
};

const requireAuth = (req, res, next) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.user = session;
  return next();
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/auth/config', (req, res) => {
  res.json({
    googleAuthConfigured: Boolean(GOOGLE_CLIENT_ID),
    googleClientId: GOOGLE_CLIENT_ID || null,
    sessionTtlMs: SESSION_MAX_AGE_MS,
  });
});

app.get('/api/auth/me', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.json({ authenticated: false });
  }
  const { sub, email, name, picture, iss, exp } = session;
  res.json({
    authenticated: true,
    user: { sub, email, name, picture },
    issuer: iss,
    expiresAt: exp,
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', buildSessionCookie('', { clear: true }));
  res.json({ authenticated: false });
});

app.post('/api/auth/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !googleOAuthClient) {
    return res.status(500).json({ error: 'Google auth not configured' });
  }
  if (!SESSION_SECRET) {
    return res.status(500).json({ error: 'Missing AUTH_SESSION_SECRET' });
  }

  const credential = req.body?.credential;
  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({ error: 'Missing Google credential' });
  }

  try {
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload) {
      return res.status(401).json({ error: 'Invalid Google credential' });
    }
    const user = {
      sub: payload.sub,
      email: payload.email ?? null,
      name: payload.name ?? null,
      picture: payload.picture ?? null,
    };
    const token = createSessionToken(user);
    res.setHeader('Set-Cookie', buildSessionCookie(token));
    res.json({ authenticated: true, user });
  } catch (error) {
    console.error('Google auth failed:', error);
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

app.get('/api/secret', requireAuth, (req, res) => {
  res.json({
    message: `You are authenticated as ${req.user?.email || req.user?.sub || 'unknown user'}.`,
  });
});

const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Login template server listening on ${PORT}`);
});
