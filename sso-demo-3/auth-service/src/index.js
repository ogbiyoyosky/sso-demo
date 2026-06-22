/**
 * sso-demo-3 auth-service — the central AUTHORIZATION service.
 *
 * In this Kong variant, authentication is NOT here anymore — Kong's `oidc`
 * plugin runs the OIDC flow and, on every authenticated request, forwards an
 * `X-Userinfo` header (base64 JSON of the user's claims, including `roles`).
 *
 * This service does two things and nothing else:
 *   1. AUTHORIZATION — apply the central POLICY table (e.g. App Two = employees
 *      only) based on the request's Host and the user's roles.
 *   2. ROUTING — on "allow", reverse-proxy the request to the real frontend or
 *      backend, after re-emitting the identity as the X-Auth-* headers the
 *      backends already know how to read. On "deny", return a 403 page.
 *
 * So the division of labour across the edge is explicit:
 *   Kong (oidc plugin) → "are you logged in?"   (authentication)
 *   auth-service        → "may you reach this?"  (authorization)  ← one place
 *   frontends/backends  → no auth logic at all
 *
 * Trust boundary: this service believes X-Userinfo because it is reachable ONLY
 * through Kong (it isn't published to the host), and Kong sets that header
 * itself, overwriting anything a client tried to smuggle in. Enforce with
 * network policy / mTLS in production.
 */

import express from 'express';
import httpProxy from 'http-proxy';

const { PORT = 4000 } = process.env;

// ---------------------------------------------------------------------------
// AUTHORIZATION POLICY — the central rules, one entry per host. Change a rule
// here and every app behind the gateway is affected; the apps stay dumb. In
// production you'd externalize this (OPA/Rego, Cedar, a DB) — same shape.
// ---------------------------------------------------------------------------
const POLICY = {
  'app-one.localhost': { appName: 'Customer Portal', requireRole: null },       // any authenticated user
  'app-two.localhost': { appName: 'Internal Tools', requireRole: 'employee' },  // employees only
};

// Where each host's traffic goes once authorized: static frontend, or /api -> backend.
const TARGETS = {
  'app-one.localhost': { frontend: 'http://frontend1:80', backend: 'http://backend1:3000' },
  'app-two.localhost': { frontend: 'http://frontend2:80', backend: 'http://backend2:3000' },
};

const proxy = httpProxy.createProxyServer({ xfwd: true });
proxy.on('error', (err, _req, res) => {
  console.error('[proxy]', err.message);
  if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
  res.end('Upstream unavailable.');
});

// Decode the identity Kong forwarded (base64 JSON userinfo: sub, email, name, roles…).
function userinfoFrom(req) {
  const raw = req.headers['x-userinfo'];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Roles may arrive as an array or a JSON-stringified array; coerce to string[].
function normalizeRoles(claims) {
  const r = claims.roles ?? claims.realm_access?.roles ?? [];
  if (Array.isArray(r)) return r;
  if (typeof r === 'string') { try { return JSON.parse(r); } catch { return [r]; } }
  return [];
}

const app = express();

app.use((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const rule = POLICY[host];
  const target = TARGETS[host];

  if (!rule || !target) {
    return res.status(404).type('text').send(`No policy for host "${host}".`);
  }

  // Kong already authenticated the request, so X-Userinfo must be present.
  const claims = userinfoFrom(req);
  if (!claims) {
    // Shouldn't happen behind Kong's oidc plugin; stay defensive.
    return res.status(401).type('text').send('Missing identity (X-Userinfo).');
  }

  const roles = normalizeRoles(claims);
  const name = claims.name ?? [claims.given_name, claims.family_name].filter(Boolean).join(' ');

  // ---- AUTHORIZATION: does this user satisfy the host's rule? ----
  if (rule.requireRole && !roles.includes(rule.requireRole)) {
    console.log(`[authz] DENY ${claims.email} → ${host} (needs ${rule.requireRole}, has ${roles.join(',') || 'none'})`);
    return res.status(403).type('html').send(denyPage(rule, claims.email, roles));
  }

  // ---- ALLOWED: hand identity to the upstream as the headers it echoes ----
  console.log(`[authz] ALLOW ${claims.email} → ${host} (${roles.join(',') || 'no roles'})`);
  req.headers['x-auth-email'] = claims.email || '';
  req.headers['x-auth-name'] = encodeURIComponent(name || '');
  req.headers['x-auth-roles'] = roles.join(',');
  req.headers['x-auth-sub'] = claims.sub || '';

  // ---- ROUTING: /api/* → backend, everything else → static frontend ----
  const upstream = req.url.startsWith('/api') ? target.backend : target.frontend;
  proxy.web(req, res, { target: upstream });
});

function denyPage(rule, email, roles) {
  return `<!doctype html><meta charset="utf-8">
<title>Access denied</title>
<div style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center">
  <h1 style="color:#b91c1c">Access denied</h1>
  <p><strong>${rule.appName}</strong> requires the <code>${rule.requireRole}</code> role.</p>
  <p>You are signed in as <strong>${email || '(unknown)'}</strong> with roles:
     <code>${roles.join(', ') || 'none'}</code>.</p>
  <p style="color:#6b7280">Only Microsoft Entra ID (in-house) sign-ins grant the
     <code>employee</code> role.</p>
  <p><a href="/oauth2/logout">Log out and try another account</a></p>
</div>`;
}

app.listen(PORT, () => console.log(`[auth-service] authZ + proxy listening on :${PORT}`));
