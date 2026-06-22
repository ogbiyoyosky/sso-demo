/**
 * sso-demo2 backend — a "zero-auth" application server.
 *
 * The contrast with ../sso-demo is the whole point:
 *
 *   sso-demo  : the backend WAS the OIDC client. It ran the authorization-code
 *               flow, validated ID tokens, managed sessions — hundreds of lines
 *               of security-critical code, duplicated in every service.
 *
 *   sso-demo2 : Kong (the gateway) is the OIDC client. By the time a request
 *               reaches this server it is ALREADY authenticated, and Kong has
 *               attached the user's identity as a header. This server contains
 *               NO openid-client, NO sessions, NO token handling. It just trusts
 *               the gateway and does authorization (role checks).
 *
 * THE TRUST BOUNDARY (important): this server believes the X-Userinfo header
 * blindly. That is only safe because the network is closed — the backend is NOT
 * published to the host (no `ports:` in docker-compose), so the ONLY way to
 * reach it is through Kong, which strips any client-supplied X-Userinfo and
 * sets its own. In production you'd enforce that with network policy / mTLS so
 * nobody can call the backend directly and forge the header.
 */

import express from 'express';

const {
  PORT = 3000,
  APP_NAME = 'App',
  // If set, the user MUST hold this realm role or they get 403. Empty = any
  // authenticated user is allowed. App Two sets REQUIRED_ROLE=employee.
  REQUIRED_ROLE = '',
  HOME_URL = 'http://localhost:8000/',
} = process.env;

const app = express();

/**
 * Decode the identity Kong forwarded. The kong-oidc plugin base64-encodes the
 * OIDC userinfo document into the X-Userinfo header. We decode it back to the
 * claims object: { sub, email, name, given_name, family_name, roles, ... }.
 * `roles` is present because realm-export.json maps realm roles into userinfo.
 */
function userFromRequest(req) {
  const raw = req.get('X-Userinfo');
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Normalize roles: Keycloak may emit them as an array or, depending on the
// mapper, a JSON-stringified array. Coerce to a plain string[].
function rolesOf(claims) {
  const r = claims.roles ?? claims.realm_access?.roles ?? [];
  if (Array.isArray(r)) return r;
  if (typeof r === 'string') {
    try { return JSON.parse(r); } catch { return [r]; }
  }
  return [];
}

app.get('/api/me', (req, res) => {
  const claims = userFromRequest(req);
  if (!claims) {
    // Should never happen behind Kong (the route is OIDC-protected), but stay
    // defensive in case someone reaches the backend by another path.
    return res.status(401).json({ error: 'no_identity_header' });
  }

  const roles = rolesOf(claims);
  // We treat the `employee` role (granted only via the Entra broker) as the
  // in-house marker; everyone else self-registered.
  const isEmployee = roles.includes('employee');
  const source = isEmployee ? 'Microsoft Entra ID (in-house)' : 'Email + password (registered)';

  // AUTHORIZATION happens here, in the app — Kong only did AUTHENTICATION.
  if (REQUIRED_ROLE && !roles.includes(REQUIRED_ROLE)) {
    console.log(`[authz] DENY ${claims.email} — lacks required role "${REQUIRED_ROLE}" (has: ${roles.join(', ') || 'none'})`);
    return res.status(403).json({
      error: 'forbidden',
      app: APP_NAME,
      required_role: REQUIRED_ROLE,
      email: claims.email,
      name: claims.name ?? [claims.given_name, claims.family_name].filter(Boolean).join(' '),
      roles,
      source,
    });
  }

  console.log(`[authz] ALLOW ${claims.email} into "${APP_NAME}" (roles: ${roles.join(', ') || 'none'})`);
  res.json({
    app: APP_NAME,
    email: claims.email,
    name: claims.name ?? [claims.given_name, claims.family_name].filter(Boolean).join(' '),
    roles,
    source,
  });
});

app.listen(PORT, () => {
  console.log(`[server] "${APP_NAME}" backend listening on :${PORT} ` +
    `(required role: ${REQUIRED_ROLE || 'none'}; home: ${HOME_URL})`);
});
