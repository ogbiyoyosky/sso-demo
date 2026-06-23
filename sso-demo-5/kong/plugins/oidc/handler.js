'use strict';

/**
 * Kong OIDC plugin — JavaScript implementation via kong-js-pdk.
 *
 * Flow:
 *   1. If request has a valid oidc_session cookie → look up session in Redis,
 *      inject X-Userinfo + X-Access-Token headers, pass through.
 *   2. If path is /oauth2/callback → verify state, exchange code for tokens,
 *      create session in Redis, set cookie, redirect to original path.
 *   3. If path is /oauth2/logout  → delete session, clear cookie, redirect to
 *      Keycloak end-session URL.
 *   4. Otherwise → generate state + nonce, store in Redis (10 min TTL), redirect
 *      to Keycloak authorization endpoint.
 *
 * Split-host logic:
 *   Browser-facing URLs (authorization_endpoint, end_session_endpoint) use the
 *   issuer derived from config.discovery (e.g. http://localhost:8080/realms/demo).
 *   Server-facing URLs (token_endpoint) replace the host with config.internal_host
 *   (e.g. keycloak:8080) so Kong can reach Keycloak inside Docker.
 */

const crypto = require('crypto');
const http   = require('http');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build browser-facing and server-facing OIDC endpoints from the discovery URL.
 * We do NOT fetch the discovery document at runtime to keep startup cheap and
 * avoid async complexity in the constructor; the Keycloak paths are well-known.
 */
function buildEndpoints(config) {
  // Strip trailing /.well-known/openid-configuration
  const issuer   = config.discovery.replace(/\/\.well-known\/openid-configuration$/, '');
  // Path segment after the host, e.g. /realms/demo
  const realmPath = issuer.replace(/^https?:\/\/[^/]+/, '');
  const internal  = `http://${config.internal_host || 'keycloak:8080'}${realmPath}`;

  return {
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
    end_session_endpoint:   `${issuer}/protocol/openid-connect/logout`,
    token_endpoint:         `${internal}/protocol/openid-connect/token`,
  };
}

/**
 * Parse the payload of a JWT without verifying the signature.
 * The ID token is issued by Keycloak and trusted implicitly here; full
 * signature verification would require fetching JWKS — out of scope for this demo.
 */
function parseJwtPayload(token) {
  const b64url = token.split('.')[1];
  const b64    = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

/**
 * Parse Cookie header into a plain object.
 * e.g. "foo=bar; baz=qux" → { foo: 'bar', baz: 'qux' }
 */
function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key]  = decodeURIComponent(val);
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
 * Perform an HTTP POST and return { status, body } where body is parsed JSON.
 */
function httpPost(url, bodyStr) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port:     u.port || 80,
        path:     u.pathname + (u.search || ''),
        method:   'POST',
        headers:  {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch (e) {
            reject(new Error(`Non-JSON response from token endpoint (${res.statusCode}): ${Buffer.concat(chunks).toString()}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Generate a cryptographically random hex string.
 */
function randomHex(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// Plugin class
// ---------------------------------------------------------------------------

class OidcPlugin {
  constructor(config) {
    this.config    = config;
    this.endpoints = buildEndpoints(config);
    // One Redis client per plugin instance, shared across requests.
    this.redis = new (require('ioredis'))({
      host:           'redis',
      port:           6379,
      lazyConnect:    false,
      reconnectOnError: () => true,
    });
    this.redis.on('error', (err) => {
      // Log but don't crash — Kong will surface errors per-request.
      console.error('[oidc] Redis error:', err.message);
    });
  }

  // -------------------------------------------------------------------------
  // access — called by Kong for every proxied request
  // -------------------------------------------------------------------------

  async access(kong) {
    const config = this.config;
    const path   = await kong.request.getPath();

    // -----------------------------------------------------------------------
    // 1. Callback — exchange authorization code for tokens
    // -----------------------------------------------------------------------
    const callbackPath = config.redirect_uri_path || '/oauth2/callback';
    if (path === callbackPath) {
      return this._handleCallback(kong);
    }

    // -----------------------------------------------------------------------
    // 2. Logout
    // -----------------------------------------------------------------------
    const logoutPath = config.logout_path || '/oauth2/logout';
    if (path === logoutPath) {
      return this._handleLogout(kong);
    }

    // -----------------------------------------------------------------------
    // 3. Check existing session
    // -----------------------------------------------------------------------
    const cookieHeader = await kong.request.getHeader('Cookie');
    const cookies      = parseCookies(cookieHeader);
    const sessionId    = cookies['oidc_session'];

    if (sessionId) {
      const sessionJson = await this.redis.get(`oidc:session:${sessionId}`);
      if (sessionJson) {
        let session;
        try { session = JSON.parse(sessionJson); } catch (_) { /* fall through */ }
        if (session) {
          // Inject upstream headers and let the request pass through.
          const userinfoB64 = Buffer.from(JSON.stringify(session.userinfo)).toString('base64');
          await kong.service.request.setHeader('X-Userinfo',     userinfoB64);
          await kong.service.request.setHeader('X-Access-Token', session.access_token || '');
          return; // pass through
        }
      }
      // Session not found in Redis (expired or tampered) — fall through to redirect.
    }

    // -----------------------------------------------------------------------
    // 4. Redirect to Keycloak authorization endpoint
    // -----------------------------------------------------------------------
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
      await kong.response.exit(400, 'Missing code or state parameter', {
        'Content-Type': 'text/plain',
      });
      return;
    }

    // Verify state
    const stateJson = await this.redis.get(`oidc:state:${state}`);
    if (!stateJson) {
      await kong.response.exit(400, 'Invalid or expired state parameter', {
        'Content-Type': 'text/plain',
      });
      return;
    }

    let stateData;
    try { stateData = JSON.parse(stateJson); } catch (_) {
      await kong.response.exit(400, 'Corrupt state data', { 'Content-Type': 'text/plain' });
      return;
    }

    // Delete state immediately (one-time use)
    await this.redis.del(`oidc:state:${state}`);

    // Build redirect_uri from Host header (same as what the browser was using)
    const host        = await kong.request.getHeader('Host');
    const redirectUri = `http://${host}${this.config.redirect_uri_path || '/oauth2/callback'}`;

    // Exchange authorization code for tokens
    const tokenBody = encodeForm({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  redirectUri,
      client_id:     this.config.client_id,
      client_secret: this.config.client_secret,
    });

    let tokenResponse;
    try {
      tokenResponse = await httpPost(this.endpoints.token_endpoint, tokenBody);
    } catch (err) {
      console.error('[oidc] Token exchange HTTP error:', err.message);
      await kong.response.exit(502, 'Token exchange failed', { 'Content-Type': 'text/plain' });
      return;
    }

    if (tokenResponse.status !== 200 || !tokenResponse.body.id_token) {
      console.error('[oidc] Token exchange failed:', JSON.stringify(tokenResponse.body));
      await kong.response.exit(502, `Token exchange error: ${JSON.stringify(tokenResponse.body)}`, {
        'Content-Type': 'text/plain',
      });
      return;
    }

    const tokens = tokenResponse.body;

    // Parse ID token payload for user claims
    let userinfo;
    try {
      userinfo = parseJwtPayload(tokens.id_token);
    } catch (err) {
      console.error('[oidc] Failed to parse ID token:', err.message);
      await kong.response.exit(502, 'Invalid ID token', { 'Content-Type': 'text/plain' });
      return;
    }

    // Create session in Redis (1 hour TTL)
    const sessionId = randomHex(24);
    const session   = {
      userinfo,
      access_token:  tokens.access_token,
      id_token:      tokens.id_token,
      refresh_token: tokens.refresh_token,
    };
    await this.redis.set(
      `oidc:session:${sessionId}`,
      JSON.stringify(session),
      'EX',
      3600
    );

    // Determine where to redirect after login (stored in state, or fall back to '/')
    const returnTo = stateData.return_to || '/';

    await kong.response.exit(302, '', {
      'Location':   returnTo,
      'Set-Cookie': `oidc_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
    });
  }

  // -------------------------------------------------------------------------
  // _handleLogout — /oauth2/logout
  // -------------------------------------------------------------------------

  async _handleLogout(kong) {
    const cookieHeader = await kong.request.getHeader('Cookie');
    const cookies      = parseCookies(cookieHeader);
    const sessionId    = cookies['oidc_session'];

    if (sessionId) {
      await this.redis.del(`oidc:session:${sessionId}`);
    }

    const redirectUri = this.config.redirect_after_logout_uri || '/';

    await kong.response.exit(302, '', {
      'Location':   redirectUri,
      // Clear the cookie by setting Max-Age=0
      'Set-Cookie': 'oidc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    });
  }

  // -------------------------------------------------------------------------
  // _redirectToAuth — redirect browser to Keycloak for authentication
  // -------------------------------------------------------------------------

  async _redirectToAuth(kong) {
    const state = randomHex(16);
    const nonce = randomHex(16);

    // Remember where the user was trying to go so we can restore after callback
    const returnTo = await kong.request.getPath();

    // Store state in Redis with 10-minute TTL
    await this.redis.set(
      `oidc:state:${state}`,
      JSON.stringify({ nonce, return_to: returnTo }),
      'EX',
      600
    );

    // Build redirect_uri from the Host header
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

    const authUrl = `${this.endpoints.authorization_endpoint}?${params}`;

    await kong.response.exit(302, '', {
      'Location': authUrl,
    });
  }
}

// ---------------------------------------------------------------------------
// Export — format required by kong-js-pdk
// ---------------------------------------------------------------------------

module.exports = {
  Name:   'oidc',
  Plugin: OidcPlugin,
  // kong-pdk wraps this array in { config: { type:'record', fields:<Schema> } }
  // automatically, so export only the inner field definitions.
  Schema: [
    { client_id:                          { type: 'string',  required: true  } },
    { client_secret:                      { type: 'string',  required: true  } },
    { discovery:                          { type: 'string',  required: true  } },
    { internal_host:                      { type: 'string'                   } },
    { redirect_uri_path:                  { type: 'string',  default: '/oauth2/callback'  } },
    { scope:                              { type: 'string',  default: 'openid profile email' } },
    { logout_path:                        { type: 'string',  default: '/oauth2/logout'    } },
    { redirect_after_logout_uri:          { type: 'string'                   } },
    { bearer_only:                        { type: 'string',  default: 'no'   } },
    { realm:                              { type: 'string',  default: 'kong' } },
    { ssl_verify:                         { type: 'string',  default: 'no'   } },
    { token_endpoint_auth_method:         { type: 'string',  default: 'client_secret_post' } },
    { filters:                            { type: 'string'                   } },
    { session_secret:                     { type: 'string'                   } },
    { recovery_page_path:                 { type: 'string'                   } },
    { timeout:                            { type: 'number'                   } },
    { response_type:                      { type: 'string',  default: 'code' } },
    { introspection_endpoint:             { type: 'string'                   } },
    { introspection_endpoint_auth_method: { type: 'string'                   } },
  ],
  Version:  '2.0.0',
  Priority: 1000,
};
