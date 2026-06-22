/**
 * sso-demo backend — a confidential OIDC client of Keycloak.
 *
 * The big picture
 * ---------------
 * This app NEVER talks to Microsoft. It only knows about Keycloak. Keycloak, in
 * turn, is configured (see keycloak/realm-export.json) to broker authentication
 * to Microsoft Entra ID. So the chain is:
 *
 *   Browser -> backend /login -> Keycloak /auth (with kc_idp_hint=microsoft)
 *           -> Microsoft sign-in page -> back to Keycloak's broker endpoint
 *           -> back to backend /auth/callback with an authorization code
 *           -> backend exchanges code for tokens (server-to-server)
 *           -> session established, browser redirected to the frontend.
 *
 * We use openid-client v6, the certified OpenID Connect implementation, which
 * handles the fiddly security-critical parts (issuer validation, ID token
 * signature verification, nonce checks) for us.
 */

import express from 'express';
import session from 'express-session';
import cors from 'cors';
import * as client from 'openid-client';

// ---------------------------------------------------------------------------
// Configuration (all overridable via environment — see docker-compose.yml)
// ---------------------------------------------------------------------------

const {
  // The issuer AS THE BROWSER SEES IT. This must match the `iss` claim inside
  // the tokens Keycloak mints, which is why Keycloak runs with KC_HOSTNAME=localhost.
  KEYCLOAK_ISSUER = 'http://localhost:8080/realms/demo',

  // Where Keycloak is actually reachable FROM THIS CONTAINER on the compose
  // network. Used only at the HTTP transport layer (see internalFetch below).
  KEYCLOAK_INTERNAL_HOST = 'keycloak:8080',

  KC_WEBAPP_CLIENT_SECRET = 'change-me-demo-secret',
  SESSION_SECRET = 'change-me-session-secret',
  FRONTEND_URL = 'http://localhost:5173',
  BACKEND_URL = 'http://localhost:3000',
  PORT = 3000,

  // Which Keycloak client this instance is. The compose file runs TWO copies
  // of this same code (web-app / web-app-2) to demonstrate single sign-on
  // across separate applications.
  CLIENT_ID = 'web-app',
} = process.env;

const REDIRECT_URI = `${BACKEND_URL}/auth/callback`;

// ---------------------------------------------------------------------------
// The issuer/hostname fix (THE classic Docker + OIDC pitfall)
// ---------------------------------------------------------------------------
// Problem: the browser reaches Keycloak at localhost:8080, but inside the
// compose network this container must use the service name keycloak:8080.
// If we simply discovered against http://keycloak:8080/..., openid-client
// would expect tokens whose `iss` is http://keycloak:8080/... — but Keycloak
// (pinned with KC_HOSTNAME=localhost) issues them with iss=http://localhost:8080/...
// and validation would fail.
//
// Fix: keep http://localhost:8080 as the issuer for ALL validation purposes,
// and swap the hostname to keycloak:8080 only at the moment we actually open
// a TCP connection. openid-client supports this cleanly via its customFetch
// hook. Issuer checks see "localhost"; packets go to "keycloak". Everyone wins.

const issuerUrl = new URL(KEYCLOAK_ISSUER);

function internalFetch(url, options) {
  const target = new URL(url);
  if (target.host === issuerUrl.host) {
    target.host = KEYCLOAK_INTERNAL_HOST;
  }
  return fetch(target.href, options);
}

// ---------------------------------------------------------------------------
// OIDC discovery (with retry — Keycloak takes ~30s to boot and import the realm)
// ---------------------------------------------------------------------------
// Discovery fetches <issuer>/.well-known/openid-configuration, which tells us
// the authorization endpoint, token endpoint, end-session endpoint, and the
// JWKS URI (the public keys used to verify ID token signatures). Hardcoding
// none of these is the whole point of discovery.

async function discoverWithRetry({ attempts = 30, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const config = await client.discovery(
        issuerUrl,
        CLIENT_ID,
        // Passing the secret as a string makes this a CONFIDENTIAL client:
        // openid-client will authenticate to the token endpoint with it.
        // (A public client, e.g. a pure SPA, would have no secret at all and
        // rely solely on PKCE.)
        KC_WEBAPP_CLIENT_SECRET,
        undefined,
        {
          // openid-client v6 refuses plain-http endpoints by default (good!).
          // This is a local learning stack, so we opt out explicitly.
          execute: [client.allowInsecureRequests],
          // Route the discovery request itself through the host rewrite.
          [client.customFetch]: internalFetch,
        },
      );
      // Route ALL subsequent requests (token exchange, JWKS fetch, ...)
      // through the host rewrite too.
      config[client.customFetch] = internalFetch;
      return config;
    } catch (err) {
      console.log(
        `[oidc] discovery attempt ${attempt}/${attempts} failed (${err.message}) — ` +
        `Keycloak is probably still booting, retrying in ${delayMs / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Could not discover OIDC issuer at ${KEYCLOAK_ISSUER} after ${attempts} attempts`);
}

console.log(`[oidc] discovering issuer ${KEYCLOAK_ISSUER} (via ${KEYCLOAK_INTERNAL_HOST})...`);
const oidcConfig = await discoverWithRetry();
console.log('[oidc] discovery OK — authorization endpoint:',
  oidcConfig.serverMetadata().authorization_endpoint);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// The frontend (a different origin: localhost:5173) calls /api/me with
// credentials, so we must both allow that origin AND allow cookies to ride
// along. `credentials: true` sets Access-Control-Allow-Credentials, and the
// frontend must use fetch(..., { credentials: 'include' }).
app.use(cors({ origin: FRONTEND_URL, credentials: true }));

// In-memory session store: perfect for learning, WRONG for production
// (sessions vanish on restart and don't share across instances — use Redis
// or similar for real deployments).
app.use(session({
  // Browsers scope cookies by HOST ONLY — the port is ignored. Both demo
  // backends live on "localhost", so if they used the same cookie name
  // (express-session's default "connect.sid") they would overwrite each
  // other's session on every request. A per-client name keeps them apart.
  name: `${CLIENT_ID}.sid`,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,    // JS on the page can never read the session cookie
    secure: false,     // we're on plain http for this demo; true in production
    sameSite: 'lax',   // sent on top-level navigations (the OIDC redirect back
                       // to /auth/callback) and on same-site fetches. localhost:5173
                       // and localhost:3000 count as the same SITE (ports don't
                       // matter for SameSite), so /api/me works too.
    maxAge: 60 * 60 * 1000, // 1 hour
  },
}));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// GET /login — kick off the Authorization Code Flow with PKCE
// ---------------------------------------------------------------------------

app.get('/login', async (req, res, next) => {
  try {
    // PKCE (Proof Key for Code Exchange): we invent a random secret (the
    // "verifier"), send only its SHA-256 hash (the "challenge") with the
    // authorization request, and reveal the verifier itself at the token
    // exchange. If an attacker steals the authorization code in transit,
    // it's useless to them — they can't produce the verifier that hashes
    // to the challenge Keycloak recorded. Required for public clients,
    // recommended defense-in-depth even for confidential ones like us.
    const code_verifier = client.randomPKCECodeVerifier();
    const code_challenge = await client.calculatePKCECodeChallenge(code_verifier);

    // state: random value echoed back by Keycloak on the redirect. We check it
    // on the callback to bind that callback to THIS browser session — it's the
    // CSRF protection for the redirect (nobody can trick your browser into
    // completing a login flow it never started).
    const state = client.randomState();

    // nonce: random value that Keycloak embeds INSIDE the signed ID token.
    // Checking it proves the token was minted for this exact login attempt
    // and isn't a replayed token from some earlier flow.
    const nonce = client.randomNonce();

    // Stash all three in the session so the callback handler can verify them.
    req.session.oidcFlight = { code_verifier, state, nonce };

    const authorizationUrl = client.buildAuthorizationUrl(oidcConfig, {
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile email',
      code_challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      // Keycloak-specific: skip Keycloak's own login page and jump straight
      // to the identity provider with alias "microsoft" (defined in
      // realm-export.json). Without this hint the user would first see a
      // Keycloak form with a "Microsoft Entra ID" button on it.
      kc_idp_hint: 'microsoft',
    });

    // Make sure the session (with our verifier/state/nonce) is persisted
    // BEFORE the browser flies off to Keycloak.
    req.session.save((err) => {
      if (err) return next(err);
      console.log('[login] redirecting browser to Keycloak authorization endpoint');
      res.redirect(authorizationUrl.href);
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /auth/callback — Keycloak redirects back here with ?code=...&state=...
// ---------------------------------------------------------------------------

app.get('/auth/callback', async (req, res, next) => {
  try {
    const flight = req.session.oidcFlight;
    if (!flight) {
      // No pending flow in this session — e.g. the user bookmarked the
      // callback URL, or the session cookie was lost mid-flow.
      return res.status(400).send('No login in progress. <a href="/login">Start over</a>.');
    }

    // Reconstruct the full callback URL (path + query) as openid-client wants
    // it. Behind the scenes authorizationCodeGrant will:
    //   1. check the returned `state` equals what we generated      (CSRF)
    //   2. POST the code + our PKCE verifier + client secret to the
    //      token endpoint (a back-channel, server-to-server call —
    //      routed through internalFetch to keycloak:8080)
    //   3. verify the ID token's signature against Keycloak's JWKS
    //   4. validate iss (must equal KEYCLOAK_ISSUER), aud, exp, iat
    //   5. check the `nonce` inside the token equals what we generated
    const currentUrl = new URL(req.originalUrl, BACKEND_URL);

    const tokens = await client.authorizationCodeGrant(oidcConfig, currentUrl, {
      pkceCodeVerifier: flight.code_verifier,
      expectedState: flight.state,
      expectedNonce: flight.nonce,
    });

    // The ID token's payload: who the user is, asserted (and signed) by Keycloak.
    // Because of the broker mappers in realm-export.json, email / given_name /
    // family_name originally came from Microsoft Entra ID.
    const claims = tokens.claims();

    // Acceptance criterion: make the flow observable.
    console.log('[callback] ID token validated. Decoded claims:');
    console.log(JSON.stringify(claims, null, 2));

    // The one-time values are spent — drop them.
    delete req.session.oidcFlight;

    // Rotate the session ID on privilege change (login) so a session ID an
    // attacker captured BEFORE authentication can't become an authenticated
    // session ("session fixation" defense).
    req.session.regenerate((err) => {
      if (err) return next(err);

      req.session.user = {
        sub: claims.sub,                          // stable Keycloak user ID
        email: claims.email,
        name: claims.name ??
          [claims.given_name, claims.family_name].filter(Boolean).join(' '),
        given_name: claims.given_name,
        family_name: claims.family_name,
      };
      // Kept so /logout can send id_token_hint — it tells Keycloak exactly
      // whose SSO session to terminate without asking the user to confirm.
      req.session.idToken = tokens.id_token;

      req.session.save((err2) => {
        if (err2) return next(err2);
        res.redirect(FRONTEND_URL);
      });
    });
  } catch (err) {
    console.error('[callback] token exchange / validation failed:', err.message);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/me — what the frontend polls to know who (if anyone) is logged in
// ---------------------------------------------------------------------------

app.get('/api/me', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  res.json(req.session.user);
});

// ---------------------------------------------------------------------------
// GET /logout — RP-initiated logout
// ---------------------------------------------------------------------------
// Destroying only our Express session is NOT enough: Keycloak still holds an
// SSO session for the user, so the very next /login would silently sign them
// back in without any prompt. The OIDC way is to redirect the browser to the
// provider's end_session_endpoint (discovered, not hardcoded) with an
// id_token_hint — Keycloak then kills ITS session too and bounces the browser
// to our post_logout_redirect_uri.
//
// (Microsoft's own session at login.microsoftonline.com survives — that's why
// the IdP is configured with prompt=select_account, so the next login still
// shows Microsoft's account picker instead of silently SSO-ing back in.)

app.get('/logout', (req, res) => {
  const idToken = req.session.idToken;

  req.session.destroy(() => {
    if (!idToken) {
      // Never logged in (or session already gone) — nothing to end at Keycloak.
      return res.redirect(FRONTEND_URL);
    }
    const endSessionUrl = client.buildEndSessionUrl(oidcConfig, {
      id_token_hint: idToken,
      post_logout_redirect_uri: FRONTEND_URL,
    });
    console.log('[logout] app session destroyed, redirecting to Keycloak end-session endpoint');
    res.redirect(endSessionUrl.href);
  });
});

// ---------------------------------------------------------------------------

// Final error handler — keep the message generic, log the details server-side.
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).send('Authentication error — check the backend logs for details.');
});

app.listen(PORT, () => {
  console.log(`[server] client "${CLIENT_ID}" listening on ${BACKEND_URL} (container port ${PORT})`);
});
