/**
 * sso-demo-4 backend — a zero-auth app server.
 *
 * Kong's oidc plugin authenticated the request and attached the user's identity
 * as the X-Userinfo header (base64 JSON of the OIDC userinfo claims, including
 * `roles`). This server just decodes and returns it — no OIDC, no sessions.
 *
 * Trust boundary: we believe X-Userinfo because this container is unpublished and
 * reachable only through Kong, which sets the header itself (overwriting any a
 * client tried to smuggle in). Enforce with network policy / mTLS in production.
 */

import express from 'express';

const { PORT = 3000, APP_NAME = 'Demo 4 API' } = process.env;
const app = express();

function userFromRequest(req) {
  const raw = req.get('X-Userinfo');
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function rolesOf(claims) {
  const r = claims.roles ?? claims.realm_access?.roles ?? [];
  if (Array.isArray(r)) return r;
  if (typeof r === 'string') { try { return JSON.parse(r); } catch { return [r]; } }
  return [];
}

app.get('/api/me', (req, res) => {
  const claims = userFromRequest(req);
  if (!claims) {
    return res.status(401).json({ error: 'no_identity_header' });
  }
  res.json({
    app: APP_NAME,
    username: claims.preferred_username,
    email: claims.email,
    name: claims.name ?? [claims.given_name, claims.family_name].filter(Boolean).join(' '),
    roles: rolesOf(claims),
  });
});

app.listen(PORT, () => console.log(`[server] "${APP_NAME}" backend on :${PORT} (zero-auth)`));
