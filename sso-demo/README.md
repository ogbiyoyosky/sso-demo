# OIDC SSO Demo — Node.js + Keycloak + Microsoft Entra ID

A complete, runnable learning project demonstrating OpenID Connect SSO with an
identity broker:

```
┌──────────┐      ┌─────────────┐      ┌──────────┐      ┌──────────────────┐
│ Frontend │ ───► │  Backend     │ ───► │ Keycloak │ ───► │ Microsoft        │
│ :5173    │      │  (Express)   │      │ :8080    │      │ Entra ID         │
│ static   │      │  :3000       │      │ broker   │      │ (cloud, manual   │
│ SPA      │      │  OIDC client │      │ + OP     │      │  setup below)    │
└──────────┘      └─────────────┘      └──────────┘      └──────────────────┘
```

- **Keycloak** is the OpenID Provider the app trusts — and an **identity
  broker** that delegates the actual login to Entra ID.
- The **backend** is a *confidential* OIDC client of Keycloak using the
  Authorization Code Flow with PKCE (`openid-client` v6).
- The **frontend** is one static HTML page; it holds no tokens, just a session
  cookie scoped to the backend.
- The app never talks to Microsoft directly, and never sees Microsoft tokens.
  Swapping Entra ID for Google/Okta/GitHub later would require **zero app
  changes** — that's the point of brokering.

---

## 1. Entra ID setup (the only manual part)

Entra ID lives in Microsoft's cloud and can't be containerized, so register an
app for Keycloak by hand (≈3 minutes):

1. Go to the [Azure portal](https://portal.azure.com) → **Microsoft Entra ID**
   → **App registrations** → **New registration**.
2. **Name**: anything, e.g. `keycloak-sso-demo`.
3. **Supported account types**: *Accounts in this organizational directory
   only* (single tenant).
4. **Redirect URI**: select platform **Web**, and enter **exactly**:

   ```
   http://localhost:8080/realms/demo/broker/microsoft/endpoint
   ```

   > This is Keycloak's **broker endpoint** — Microsoft sends the user (and the
   > authorization code) back *here*, to Keycloak, not to your app. The path
   > encodes the realm (`demo`) and the identity-provider alias (`microsoft`)
   > defined in [keycloak/realm-export.json](keycloak/realm-export.json).
   > Entra allows plain `http` only for `localhost` redirect URIs.

5. Click **Register**. From the **Overview** page, copy:
   - **Application (client) ID** → `ENTRA_CLIENT_ID`
   - **Directory (tenant) ID** → `ENTRA_TENANT_ID`
6. Go to **Certificates & secrets** → **New client secret**. Copy the secret's
   **Value** immediately (it is shown only once — the *Secret ID* column is
   **not** what you want) → `ENTRA_CLIENT_SECRET`.

## 2. Run it

```bash
cp .env.example .env
# edit .env — paste in the three ENTRA_* values from step 1
docker compose up --build
```

Keycloak takes ~30 seconds to boot and import the realm; the backend waits for
its healthcheck and retries discovery, so just wait for:

```
backend-1  | [oidc] discovery OK — authorization endpoint: http://localhost:8080/realms/demo/...
```

| What | URL | Credentials |
|---|---|---|
| App One frontend | http://localhost:5173 | — |
| App One backend | http://localhost:3000 | — |
| App Two frontend | http://localhost:5174 | — |
| App Two backend | http://localhost:3001 | — |
| Keycloak admin console | http://localhost:8080 | `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` from `.env` |

Open the frontend, click **Login with Microsoft**, sign in with your Microsoft
account, and your name + email appear — pulled from `/api/me`, backed by a
verified ID token. The backend logs the full decoded claims on every login.

## 3. How the flow works

1. **`GET http://localhost:3000/login`** — the backend generates three random
   values: a **PKCE verifier** (its SHA-256 hash goes in the URL; the verifier
   itself is revealed only at token exchange, so a stolen code is useless), a
   **state** (anti-CSRF: ties the eventual callback to this browser session),
   and a **nonce** (anti-replay: Keycloak bakes it into the signed ID token).
   It stores them in the session and redirects the browser to Keycloak's
   authorization endpoint with **`kc_idp_hint=microsoft`**.
2. **Keycloak** sees the hint, skips its own login form entirely, and
   immediately redirects to Microsoft's authorize endpoint — Keycloak is now
   acting as an OIDC *client of Microsoft*, running its own second
   authorization-code flow.
3. **Microsoft** authenticates the user and redirects back to Keycloak's broker
   endpoint (`/realms/demo/broker/microsoft/endpoint`) with a code. Keycloak
   exchanges it, validates Microsoft's ID token, and creates/updates a local
   Keycloak user (the broker mappers copy `email`, `given_name`, `family_name`
   into the profile).
4. **Keycloak** redirects the browser to the backend's
   `http://localhost:3000/auth/callback` with *its own* authorization code.
5. **The backend** checks `state`, then exchanges the code (sending the PKCE
   verifier + client secret server-to-server), and `openid-client` verifies
   the ID token's **signature** against Keycloak's published keys plus the
   `iss`, `aud`, `exp`, and `nonce` claims. The claims go into the session,
   the session ID is rotated (anti-fixation), and the browser is sent back to
   the frontend.
6. **The frontend** calls `GET /api/me` with `credentials: 'include'` and
   renders the name and email.
7. **Logout** (`GET /logout`) destroys the app session, then redirects the
   browser to Keycloak's `end_session_endpoint` with an `id_token_hint`
   (RP-initiated logout) — killing the Keycloak SSO session too — and Keycloak
   bounces back to the frontend. Without this second step, the next "Login"
   click would silently sign you back in.

## 3b. Seeing actual *single sign-on* — the two-app test

The stack runs **two independent applications**: App One (`:5173`/`:3000`,
Keycloak client `web-app`) and App Two (`:5174`/`:3001`, client `web-app-2`).
They share no code paths at runtime, no cookies, no sessions — only the same
Keycloak realm. That's what makes this test meaningful:

1. Open **App One** (http://localhost:5173) → Login → Microsoft prompts →
   you're signed in.
2. Open **App Two** (http://localhost:5174) → it shows you as logged *out*
   (correct! its own session cookie doesn't exist yet).
3. Click Login in App Two → a few instant redirects, **no Microsoft prompt,
   no Keycloak form** → you're signed in.

That silent step 3 is single sign-on. App Two ran the *entire* authorization
code flow — but when its request hit Keycloak's authorization endpoint, the
browser presented Keycloak's own SSO session cookie (set during step 1), so
Keycloak skipped authentication and issued a code immediately. Verify in the
admin console: **Sessions** shows one user session with two clients attached.

Logout semantics worth observing:

- Logout from App One kills App One's session **and** the Keycloak SSO
  session. App Two's *local* session keeps working until its cookie expires —
  ending other apps' active sessions requires back-channel/front-channel
  logout, which is deliberately out of scope here.
- After that logout, a fresh login from *either* app prompts Microsoft again,
  proving the SSO session really died.

The two backends are the same image with different env (`CLIENT_ID`,
ports, secrets); the session cookie is named per client (`web-app.sid` /
`web-app-2.sid`) because browsers scope cookies by host *without the port* —
with the default shared name, the two apps on `localhost` would overwrite
each other's sessions.

## 4. The issuer/hostname problem (read before debugging!)

Your browser reaches Keycloak at `http://localhost:8080`. The backend
container, on the compose network, would naturally reach it at
`http://keycloak:8080`. But OIDC tokens embed the issuer URL (`iss` claim),
and **the client must validate it** — so if the backend discovered Keycloak
under one hostname while tokens were issued under another, validation fails
with errors like `unexpected JWT "iss" (issuer) claim value`.

This project solves it with one consistent issuer plus a transport-level rewrite:

1. Keycloak runs with **`KC_HOSTNAME=localhost`**, so every token and every
   discovery document says `http://localhost:8080/realms/demo` regardless of
   which interface the request arrived on.
2. The backend uses `http://localhost:8080/realms/demo` as the issuer for all
   *validation*, but its HTTP layer rewrites `localhost:8080 → keycloak:8080`
   right before sending each server-to-server request (discovery, token
   exchange, JWKS fetch). See `internalFetch` in
   [backend/src/index.js](backend/src/index.js) — it plugs into
   `openid-client`'s `customFetch` hook.

An alternative you'll see in the wild is `extra_hosts: ["localhost:host-gateway"]`
on the backend container, making the container's `localhost` literally reach the
host machine. It works, but it races against the container's own loopback entry
in `/etc/hosts` and behaves differently across platforms — the fetch-rewrite
approach is deterministic.

## 5. Troubleshooting

**Entra error: `AADSTS50011: The redirect URI ... does not match`**
The redirect URI on the Entra app registration must be byte-for-byte
`http://localhost:8080/realms/demo/broker/microsoft/endpoint` — check for a
trailing slash, `https` instead of `http`, or a typo'd realm/alias. It must be
registered under the **Web** platform, not SPA.

**Keycloak error page: `Invalid parameter: redirect_uri`**
Keycloak rejected the *app's* callback. The `web-app` client only allows
`http://localhost:3000/auth/callback` — if you changed the backend port or
path, update `redirectUris` in `keycloak/realm-export.json` and re-import (the
import only runs against a fresh realm: `docker compose down -v` then up).

**Backend error: `unexpected JWT "iss" claim` or discovery hangs/refuses**
This is the issuer/hostname problem from section 4. Check that
`KC_HOSTNAME=localhost` is set on the keycloak service and that the backend's
`KEYCLOAK_ISSUER` is `http://localhost:8080/realms/demo` (browser-visible
form), with `KEYCLOAK_INTERNAL_HOST=keycloak:8080` for actual transport.

**Token validation fails with `exp`/`iat`/"token used before issued" errors**
Clock skew: the container's clock disagrees with Keycloak's or Microsoft's.
Docker Desktop VMs are notorious for clock drift after the host sleeps —
restart Docker Desktop (or `docker compose restart`). JWT `exp`/`iat` checks
allow only small leeway, so even a minute of drift breaks logins.

**Login works but name/email are empty**
The Entra ID token only carries `email`/`given_name`/`family_name` when the
`profile email` scopes are granted; some tenants also require optional claims.
Check the backend's decoded-claims log to see what actually arrived, and the
Keycloak admin console → Users to see what the broker mappers imported.

**Changed the realm JSON but nothing happened**
`--import-realm` skips realms that already exist. Wipe state with
`docker compose down -v && docker compose up --build`.

## 6. Production caveats (deliberately simplified here)

- **In-memory session store** (`express-session` MemoryStore): sessions die on
  restart, leak memory, and can't be shared across instances. Use Redis or a
  database-backed store in production.
- Plain **HTTP** everywhere, `secure: false` cookies, `start-dev` Keycloak,
  `allowInsecureRequests` in openid-client — all local-only conveniences.
- Client secrets in `.env` — use a secrets manager for real deployments.
- Microsoft's own browser session at `login.microsoftonline.com` survives our
  logout (we configured `prompt=select_account` on the IdP so you still see an
  account picker). Full single-logout across the IdP is a deeper topic
  (front/back-channel logout).
