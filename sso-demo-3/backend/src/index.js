/**
 * sso-demo-3 backend — the purest "zero-auth" app server of the three demos.
 *
 * There is NO authentication AND NO authorization code here. By the time a
 * request arrives, Traefik has already consulted the auth-service, which both
 * verified the session AND approved this host for this user — then attached the
 * identity as headers. This server just reads them.
 *
 * Trust boundary: we believe X-Auth-* blindly. Safe only because this container
 * is unpublished and reachable solely through Traefik, which sets these headers
 * itself (and would overwrite any a client tried to smuggle in). Enforce that
 * with network policy / mTLS in production.
 */

import express from 'express';

const { PORT = 3000, APP_NAME = 'App' } = process.env;
const app = express();

app.get('/api/me', (req, res) => {
  const email = req.get('X-Auth-Email') || null;
  // The auth-service URL-encodes the name so unicode/spaces survive the header.
  const nameRaw = req.get('X-Auth-Name') || '';
  const name = nameRaw ? decodeURIComponent(nameRaw) : null;
  const roles = (req.get('X-Auth-Roles') || '').split(',').filter(Boolean);

  if (!email) {
    // Should be impossible behind Traefik+forward-auth; stay defensive.
    return res.status(401).json({ error: 'no_identity_headers' });
  }

  const source = roles.includes('employee')
    ? 'Microsoft Entra ID (in-house)'
    : 'Email + password (registered)';

  res.json({ app: APP_NAME, email, name, roles, source });
});

app.listen(PORT, () => console.log(`[server] "${APP_NAME}" backend on :${PORT} (zero-auth)`));
