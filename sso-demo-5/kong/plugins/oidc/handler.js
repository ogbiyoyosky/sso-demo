'use strict';

/**
 * Kong OIDC plugin — provider-agnostic JavaScript implementation via kong-js-pdk.
 *
 * Supports Keycloak (dev/staging) and Microsoft Entra ID (production) without
 * code changes. The active provider is selected by OIDC_PROVIDER in .env and
 * resolved by kong/entrypoint.sh into generic OIDC_* config vars.
 *
 * Flow:
 *   1. Startup: fetch + cache the provider's discovery document.
 *   2. Incoming request with valid oidc_session cookie → look up Redis session,
 *      inject X-Userinfo + X-Access-Token headers, pass through.
 *   3. Path = redirect_uri_path (/oauth2/callback) → exchange code, create session.
 *   4. Path = logout_path (/oauth2/logout) → delete session, redirect to provider
 *      end_session_endpoint with post_logout_redirect_uri.
 *   5. No session → redirect to provider authorization_endpoint.
 *
 * Split-host (Keycloak only):
 *   When internal_host is set, the discovery document is fetched via that internal
 *   address, and token_endpoint is rewritten to use it. authorization_endpoint and
 *   end_session_endpoint remain on the public host (browser-facing).
 *   For Entra, internal_host is empty and all endpoints are used as-is from the
 *   discovery document.
 */

const crypto = require('crypto');
const http   = require('http');
const https  = require('https');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the OIDC discovery document.
 * If internalHost is set (Keycloak split-host), rewrites the fetch URL so Kong
 * can reach Keycloak inside Docker, but keeps browser-facing endpoint URLs intact.
 */
function fetchDiscovery(discoveryUrl, internalHost) {
  return new Promise((resolve, reject) => {
    let fetchUrl = discoveryUrl;
    if (internalHost) {
      fetchUrl = discoveryUrl.replace(/^https?:\/\/[^/]+/, `http://${internalHost}`);
    }

    const u   = new URL(fetchUrl);
    const mod = u.protocol === 'https:' ? https : http;

    const req = mod.get(
      {
        hostname: u.hostname,
        port:     u.port || (u.protocol === 'https:' ? 443 : 80),
        path:     u.pathname + (u.search || ''),
      },
      (res) => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          try {
            const doc = JSON.parse(Buffer.concat(chunks).toString());
            // token_endpoint is server-facing: rewrite host to internalHost when set.
            // authorization_endpoint + end_session_endpoint are browser-facing: use as-is.
            let tokenEndpoint = doc.token_endpoint;
            if (internalHost) {
              tokenEndpoint = doc.token_endpoint.replace(
                /^https?:\/\/[^/]+/,
                `http://${internalHost}`
              );
            }
            resolve({
              authorization_endpoint: doc.authorization_endpoint,
              token_endpoint:         tokenEndpoint,
              end_session_endpoint:   doc.end_session_endpoint,
            });
          } catch (e) {
            reject(new Error(`Failed to parse discovery doc from ${fetchUrl}: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Parse the payload of a JWT without verifying the signature.
 */
function parseJwtPayload(token) {
  const b64url = token.split('.')[1];
  const b64    = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

/**
 * Parse Cookie header into { name: value } pairs.
 */
function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

/**
 * URL-encode an object as application/x-www-form-urlencoded.
 */
function encodeForm(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * HTTP(S) POST — returns { status, body } with body parsed as JSON.
 * Automatically selects http/https module based on the URL scheme.
 */
function httpPost(url, bodyStr) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port:     u.port || (u.protocol === 'https:' ? 443 : 80),
        path:     u.pathname + (u.search || ''),
        method:   'POST',
        headers:  {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch (e) {
            reject(new Error(`Non-JSON response (${res.statusCode}): ${Buffer.concat(chunks)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function randomHex(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// Plugin class
// ---------------------------------------------------------------------------

class OidcPlugin {
  constructor(config) {
    this.config = config;
    // Kick off discovery fetch at instantiation; cache the promise so every
    // request awaits the same resolved value after the first resolution.
    this._endpoints = fetchDiscovery(
      config.discovery,
      config.internal_host || ''
    );
    this._endpoints.catch(err =>
      console.error('[oidc] Discovery fetch failed:', err.message)
    );

    this.redis = new (require('ioredis'))({
      host:             process.env.REDIS_HOST || 'redis',
      port:             parseInt(process.env.REDIS_PORT || '6379', 10),
      lazyConnect:      false,
      reconnectOnError: () => true,
    });
    this.redis.on('error', err => console.error('[oidc] Redis error:', err.message));
  }

  async _getEndpoints(kong) {
    try {
      return await this._endpoints;
    } catch (err) {
      console.error('[oidc] Discovery unavailable:', err.message);
      await kong.response.exit(502, 'OIDC provider unavailable', { 'Content-Type': 'text/plain' });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // access — called by Kong for every proxied request
  // -------------------------------------------------------------------------

  async access(kong) {
    const path         = await kong.request.getPath();
    const callbackPath = this.config.redirect_uri_path || '/oauth2/callback';
    const logoutPath   = this.config.logout_path       || '/oauth2/logout';

    if (path === callbackPath) return this._handleCallback(kong);
    if (path === logoutPath)   return this._handleLogout(kong);

    const cookies   = parseCookies(await kong.request.getHeader('Cookie'));
    const sessionId = cookies['oidc_session'];

    if (sessionId) {
      const sessionJson = await this.redis.get(`oidc:session:${sessionId}`);
      if (sessionJson) {
        let session;
        try { session = JSON.parse(sessionJson); } catch (_) {}
        if (session) {
          await kong.service.request.setHeader(
            'X-Userinfo',
            Buffer.from(JSON.stringify(session.userinfo)).toString('base64')
          );
          await kong.service.request.setHeader('X-Access-Token', session.access_token || '');
          return;
        }
      }
    }

    return this._redirectToAuth(kong);
  }

  // -------------------------------------------------------------------------
  // _handleCallback — /oauth2/callback
  // -------------------------------------------------------------------------

  async _handleCallback(kong) {
    const query = await kong.request.getQuery();
    const code  = query['code'];
    const state = query['state'];

    if (!code || !state) {
      await kong.response.exit(400, 'Missing code or state parameter', { 'Content-Type': 'text/plain' });
      return;
    }

    const stateJson = await this.redis.get(`oidc:state:${state}`);
    if (!stateJson) {
      await kong.response.exit(400, 'Invalid or expired state parameter', { 'Content-Type': 'text/plain' });
      return;
    }

    let stateData;
    try { stateData = JSON.parse(stateJson); } catch (_) {
      await kong.response.exit(400, 'Corrupt state data', { 'Content-Type': 'text/plain' });
      return;
    }
    await this.redis.del(`oidc:state:${state}`);

    const endpoints = await this._getEndpoints(kong);
    if (!endpoints) return;

    const host        = await kong.request.getHeader('Host');
    const redirectUri = `http://${host}${this.config.redirect_uri_path || '/oauth2/callback'}`;

    let tokenResponse;
    try {
      tokenResponse = await httpPost(
        endpoints.token_endpoint,
        encodeForm({
          grant_type:    'authorization_code',
          code,
          redirect_uri:  redirectUri,
          client_id:     this.config.client_id,
          client_secret: this.config.client_secret,
        })
      );
    } catch (err) {
      console.error('[oidc] Token exchange HTTP error:', err.message);
      await kong.response.exit(502, 'Token exchange failed', { 'Content-Type': 'text/plain' });
      return;
    }

    if (tokenResponse.status !== 200 || !tokenResponse.body.id_token) {
      console.error('[oidc] Token exchange failed:', JSON.stringify(tokenResponse.body));
      await kong.response.exit(502, `Token exchange error: ${JSON.stringify(tokenResponse.body)}`, { 'Content-Type': 'text/plain' });
      return;
    }

    let userinfo;
    try {
      userinfo = parseJwtPayload(tokenResponse.body.id_token);
    } catch (err) {
      console.error('[oidc] Failed to parse ID token:', err.message);
      await kong.response.exit(502, 'Invalid ID token', { 'Content-Type': 'text/plain' });
      return;
    }

    const sessionId = randomHex(24);
    await this.redis.set(
      `oidc:session:${sessionId}`,
      JSON.stringify({
        userinfo,
        access_token:  tokenResponse.body.access_token,
        id_token:      tokenResponse.body.id_token,
        refresh_token: tokenResponse.body.refresh_token,
      }),
      'EX', 3600
    );

    await kong.response.exit(302, '', {
      'Location':   stateData.return_to || '/',
      'Set-Cookie': `oidc_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
    });
  }

  // -------------------------------------------------------------------------
  // _handleLogout — /oauth2/logout
  // -------------------------------------------------------------------------

  async _handleLogout(kong) {
    const cookies   = parseCookies(await kong.request.getHeader('Cookie'));
    const sessionId = cookies['oidc_session'];
    if (sessionId) await this.redis.del(`oidc:session:${sessionId}`);

    // Build the provider end-session URL. Both Keycloak and Entra support
    // post_logout_redirect_uri — no provider-specific branching needed.
    let logoutUrl = this.config.app_base_url || '/';
    try {
      const endpoints = await this._endpoints;
      if (endpoints.end_session_endpoint) {
        logoutUrl = `${endpoints.end_session_endpoint}?${encodeForm({
          post_logout_redirect_uri: this.config.app_base_url || '/',
          client_id:                this.config.client_id,
        })}`;
      }
    } catch (_) {
      // Discovery failed — fall back to app root
    }

    await kong.response.exit(302, '', {
      'Location':   logoutUrl,
      'Set-Cookie': 'oidc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    });
  }

  // -------------------------------------------------------------------------
  // _redirectToAuth — redirect browser to provider authorization endpoint
  // -------------------------------------------------------------------------

  async _redirectToAuth(kong) {
    const endpoints = await this._getEndpoints(kong);
    if (!endpoints) return;

    const state    = randomHex(16);
    const nonce    = randomHex(16);
    const returnTo = await kong.request.getPath();

    await this.redis.set(
      `oidc:state:${state}`,
      JSON.stringify({ nonce, return_to: returnTo }),
      'EX', 600
    );

    const host        = await kong.request.getHeader('Host');
    const redirectUri = `http://${host}${this.config.redirect_uri_path || '/oauth2/callback'}`;

    const params = encodeForm({
      response_type: this.config.response_type || 'code',
      client_id:     this.config.client_id,
      redirect_uri:  redirectUri,
      scope:         this.config.scope || 'openid profile email',
      state,
      nonce,
    });

    await kong.response.exit(302, '', {
      'Location': `${endpoints.authorization_endpoint}?${params}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Export — format required by kong-js-pdk
// ---------------------------------------------------------------------------

module.exports = {
  Name:   'oidc',
  Plugin: OidcPlugin,
  Schema: [
    { client_id:                          { type: 'string', required: true } },
    { client_secret:                      { type: 'string', required: true } },
    { discovery:                          { type: 'string', required: true } },
    { internal_host:                      { type: 'string' } },
    { app_base_url:                       { type: 'string', default: 'http://localhost:8000' } },
    { redirect_uri_path:                  { type: 'string', default: '/oauth2/callback' } },
    { scope:                              { type: 'string', default: 'openid profile email' } },
    { logout_path:                        { type: 'string', default: '/oauth2/logout' } },
    { response_type:                      { type: 'string', default: 'code' } },
    { ssl_verify:                         { type: 'string', default: 'no' } },
    { token_endpoint_auth_method:         { type: 'string', default: 'client_secret_post' } },
    { bearer_only:                        { type: 'string', default: 'no' } },
    { filters:                            { type: 'string' } },
    { session_secret:                     { type: 'string' } },
    { timeout:                            { type: 'number' } },
    { introspection_endpoint:             { type: 'string' } },
    { introspection_endpoint_auth_method: { type: 'string' } },
  ],
  Version:  '2.1.0',
  Priority: 1000,
};
