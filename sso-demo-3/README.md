# OIDC SSO Demo 3 — Kong (OIDC plugin) for authN + a central auth-service for authZ

A runnable learning project where **Kong's OIDC plugin authenticates** every
request at the edge, then hands it to a **single auth-service that authorizes**
it (central policy) before any app is reached. The apps behind it contain *no*
auth code at all — not even a role check.

It's the hybrid of the two earlier demos: Kong does authentication at the
gateway (like `sso-demo2`), but authorization is centralized in one service
(the spirit of a forward-auth/edge-authz layer) instead of being scattered
across the backends.

```
 Browser
   │  http://app-one.localhost          http://app-two.localhost
   ▼
┌──────────────────────────── Kong :80 ──────────────────────────────────────┐
│  oidc plugin = confidential OIDC client of Keycloak (AUTHENTICATION)         │
│    • no session?  → 302 to Keycloak login                                    │
│    • on return    → exchange code, session in REDIS, inject X-Userinfo        │
│  upstream for BOTH apps = the auth-service (preserve_host: true)             │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────── auth-service :4000 ────────────────────────────────┐
│  AUTHORIZATION (central POLICY table) + reverse proxy:                       │
│    • decode X-Userinfo → apply per-host rule (App Two = employees only)       │
│    • allow → set X-Auth-Email/-Name/-Roles/-Sub, proxy onward                 │
│             (/api → backend, else → static frontend)                          │
│    • deny  → 403 access-denied page (the app is never reached)                │
└────┬──────────────────────────────────────────────────┬────────────────────┘
     ▼ allowed                                            ▼ allowed + /api
  frontend1 / frontend2 (static)               backend1 / backend2 (echo headers)

            ▲ server-to-server: token / jwks / userinfo (→ keycloak:8080)
            │                                              Redis ◄─ Kong sessions
      Keycloak :8080 ── broker ──► Microsoft Entra ID
        ├─ "Microsoft"  → in-house users → role: employee
        └─ "Register"   → outside users  → role: customer
            │
            ▼
      Postgres :5432   ← all users persisted
```

## How it differs from the other two demos

| | Who is the OIDC client? | Authentication | Authorization |
|---|---|---|---|
| `sso-demo` | each backend | in every app | in every app |
| `sso-demo2` | Kong (plugin) | at the gateway | in every app (role check per backend) |
| `sso-demo-3` (this) | Kong (plugin) | **at the gateway** | **in one central auth-service** |

The split is the point: **Kong answers "are you logged in?"**, the
**auth-service answers "may you reach this?"**. Adding an app or changing a rule
is a one-line edit to the `POLICY` table in
[auth-service/src/index.js](auth-service/src/index.js); the apps never grow auth
code.

## 1. Entra ID setup (the only manual part)

Same realm (`demo`) and IdP alias (`microsoft`) as the other demos, so the
broker redirect URI is unchanged — **if you already set up Entra for `sso-demo`,
it works here too** (and `.env` is pre-filled). Otherwise register an app in
[Entra](https://portal.azure.com) with redirect URI (platform **Web**):

```
http://localhost:8080/realms/demo/broker/microsoft/endpoint
```

and copy the tenant id / client id / client secret into `.env`.

## 2. Run it

> Stop `sso-demo` / `sso-demo2` first — they all publish port 8080 (this one
> also uses :80).

```bash
cp .env.example .env     # (a filled-in .env already ships here)
docker compose up --build
```

The first build compiles the OIDC Lua deps and vendors the Kong-3.x-ported
plugin (see §5). Wait for Keycloak to import the realm and Kong to report
`Kong started`.

| What | URL | Notes |
|---|---|---|
| App One — Customer Portal | http://app-one.localhost | any authenticated user |
| App Two — Internal Tools | http://app-two.localhost | **employees only** |
| Keycloak admin console | http://localhost:8080 | `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` |
| Kong admin API | http://localhost:8001 | `curl localhost:8001` to inspect routes/plugins |

> `*.localhost` resolves to `127.0.0.1` automatically in modern browsers; no
> hosts-file edit needed. If yours doesn't, add
> `127.0.0.1 app-one.localhost app-two.localhost` to `/etc/hosts`.

## 3. The request lifecycle

Open **http://app-one.localhost**:

1. Kong matches the `app-one` route, whose **oidc plugin** runs first. No session
   cookie yet → the plugin starts an Authorization Code + PKCE flow and **302s
   the browser to Keycloak** (the `authorization_endpoint`, on `localhost:8080`).
2. Keycloak shows its login page — **Microsoft Entra ID** (in-house) *and*
   **Register / email + password** (outside). You pick one and authenticate.
3. Keycloak redirects to `http://app-one.localhost/oauth2/callback`. The oidc
   plugin intercepts that path, **exchanges the code** for tokens
   (server-to-server to `keycloak:8080`), validates the ID token, stores the
   session in **Redis**, and injects `X-Userinfo` (base64 JSON of the userinfo
   claims, including `roles`).
4. Kong proxies the now-authenticated request to the **auth-service** (with
   `preserve_host: true`, so it still sees `Host: app-one.localhost`).
5. The auth-service decodes `X-Userinfo`, applies the **policy** for
   `app-one.localhost` (any authenticated user is fine), re-emits the identity as
   `X-Auth-Email/-Name/-Roles/-Sub`, and **reverse-proxies** to `frontend1`
   (root path) or `backend1` (`/api/*`).
6. The page calls `/api/me`; the same chain runs and `backend1` just echoes the
   `X-Auth-*` headers. **The backend ran no auth.**

### authN vs authZ, made literal

- **Authentication** ("who are you?") = the OIDC flow + session, done by **Kong's
  oidc plugin** (steps 1–3).
- **Authorization** ("may you reach *this* host?") = the **auth-service POLICY**
  lookup. App Two requires the `employee` role:

  ```js
  const POLICY = {
    'app-one.localhost': { appName: 'Customer Portal', requireRole: null },
    'app-two.localhost': { appName: 'Internal Tools',  requireRole: 'employee' },
  };
  ```

  A **customer** who opens **http://app-two.localhost** is authenticated fine by
  Kong, then the auth-service's policy fails → it returns **403 with an
  access-denied page**, so `frontend2` is never reached. Sign in through
  **Microsoft** (→ `employee`) and you're in. **Kong did authentication; the
  auth-service's policy did authorization; the app did nothing.**

> Verified with synthetic identities (no login needed): a `customer` X-Userinfo →
> App Two returns `403`; an `employee` → App Two `/api/me` returns the profile
> JSON from `backend2`; a `customer` → App One `/api/me` returns JSON from
> `backend1`.

## 3b. Single sign-on across the two apps

App One and App Two are different hostnames, so Kong's OIDC session cookie is
scoped per host (independent sessions). But they share **one Keycloak SSO
session**. After signing in to App One, opening App Two completes login **with no
prompt** — Keycloak reuses the SSO session and issues a code instantly. (As an
employee you land in App Two; as a customer you're silently authenticated and
*then* shown the 403 — still proving SSO happened.) `/oauth2/logout` clears the
Kong session and bounces to Keycloak's end-session endpoint.

## 4. Pros & cons of this pattern

**Pros**
- **Authentication implemented once** at the gateway (Kong), in front of any app.
- **All policy in one place.** Authorization lives in the auth-service; downstream
  apps are truly zero-auth, in any language, with no logic to drift.
- **Centralized changes.** Tighten a rule once; it applies everywhere with no app
  redeploys. Swap the `POLICY` object for OPA/Rego or Cedar without touching apps.

**Cons**
- **An extra hop on every request.** All app traffic flows through the
  auth-service, which is a hot path and a single point of failure — make it HA.
- **Coarse by default.** The auth-service decides on host/path/roles, not request
  bodies — object-level authZ ("can Alice edit *this* document?") still belongs in
  the app.
- **Two moving parts to operate** (Kong + auth-service) vs. doing the role check
  inline in each app (which is what `sso-demo2` does).

When it's worth it: many heterogeneous services needing consistent, centrally
governed access control. When it's overkill: a single app, or rules that depend
on per-resource context the gateway can't see.

## 5. The Kong OIDC plugin (how it's built)

Kong OSS ships no OIDC plugin, so [kong/Dockerfile](kong/Dockerfile) adds one,
working around two real-world snags:

- **luarocks can't load luarocks.org's manifest** on this image's Lua 5.1
  ("main function has more than 65536 constants"). So the OIDC Lua deps
  (`lua-resty-session` 3.10, `lua-resty-jwt`, `lua-resty-openidc` 1.7.6) are
  installed by **direct `.src.rock` URL with `--deps-mode=none`**, which never
  touches the manifest.
- **`nokia/kong-oidc` targets Kong 2.x** — its handler requires the removed
  `kong.plugins.base_plugin`, and its schema uses the old flat format. So a
  **Kong-3.x-ported copy is vendored in this repo** at
  [kong/plugins/oidc/](kong/plugins/oidc/): `handler.lua` rewritten to the 3.x
  plugin interface, `schema.lua` rewritten to the 3.x record format, helpers
  unchanged.

## 5b. The issuer/hostname problem (read before debugging `iss` errors!)

OIDC tokens embed the issuer (`iss`); the client validates it, so the URL the
**browser** uses for Keycloak and the URL **Kong** uses server-to-server must
yield the *same* issuer. Two constraints collide:

- **Entra** only allows a plain-`http` redirect URI for the literal host
  `localhost` → Keycloak's issuer must be `http://localhost:8080/...`
  (`KC_HOSTNAME=localhost`).
- **Kong** (in a container) can't reach Keycloak at `localhost:8080` — that's
  Kong itself. And unlike `sso-demo`'s Node client, lua-resty-openidc has **no
  per-request URL-rewrite hook** (its `http_request_decorator` can change request
  options but not the target URL), and the `localhost:host-gateway` trick doesn't
  help OpenResty's cosocket DNS.

The fix (in [kong/plugins/oidc/utils.lua](kong/plugins/oidc/utils.lua)): when an
`internal_host` is configured, the plugin hands lua-resty-openidc a **pre-built
discovery table** instead of a URL to fetch (openidc uses a table verbatim). The
table **splits the URLs**:

- browser-facing endpoints (`authorization_endpoint`, `end_session_endpoint`) and
  `issuer` keep `localhost:8080` → the browser can reach them and the id_token
  `iss` matches;
- server-facing endpoints (`token_endpoint`, `userinfo_endpoint`, `jwks_uri`)
  use `keycloak:8080` → Kong reaches Keycloak over the compose network.

## 6. Troubleshooting

**Kong fails to start / `plugin 'oidc' not found`** — rebuild without cache
(`docker compose build --no-cache kong`); confirm `KONG_PLUGINS=bundled,oidc`.

**`connection refused` to `localhost:8080` in Kong logs** — the issuer/hostname
issue (§5b). Confirm each route's oidc config has `internal_host: keycloak:8080`.

**`AADSTS50011: redirect URI does not match`** — the Entra registration's
redirect URI must be exactly
`http://localhost:8080/realms/demo/broker/microsoft/endpoint` under **Web**.

**`invalid_client` at token exchange** — Kong's `client_secret` in
[kong/kong.yml](kong/kong.yml) must equal the `auth-service` client secret
Keycloak imported (`AUTH_SERVICE_SECRET`). Kong does not read `.env`.

**App Two always denies you** — you're a `customer`, not an `employee`. Only the
Microsoft/Entra sign-in grants `employee` (hardcoded IdP mapper).

**`403`/`401` on every app even when logged in** — check the auth-service
`[authz]` logs. If roles are empty, the realm-roles protocol mapper isn't
emitting `roles` into the userinfo response (Kong forwards userinfo); confirm
`userinfo.token.claim=true` on that mapper in `keycloak/realm-export.json`.

**Changed the realm JSON but nothing changed** — import skips an existing realm
(and Postgres persists it). Wipe state: `docker compose down -v && docker compose up --build`.

## 7. Production caveats (deliberately simplified)

- **Apps trust `X-Auth-*` and the auth-service trusts `X-Userinfo` blindly.**
  Safe only because the backends and auth-service are unpublished and reachable
  only through Kong (which sets `X-Userinfo` and overwrites client-supplied
  copies). Enforce with network policy / mTLS in production.
- **Plain HTTP**, `secure=off` cookies, `ssl_verify=no`, `start-dev` Keycloak —
  all local-only. Flip every one behind TLS.
- **Single Kong / auth-service / Redis / Postgres** — no HA, and the auth-service
  is a hot path. Redis (Kong's session store) is what *lets* you scale Kong; you'd
  still cluster the rest.
- **Hardcoded secrets** in `kong/kong.yml` and `.env` — use a secrets manager.
- **The kong-oidc plugin is a community plugin, ported here for Kong 3.x.** Pin
  and test versions deliberately (§5).
- **Coarse roles + a JS policy table** — fine for host/role gating. For richer,
  externally-governed policy, replace `POLICY` with OPA/Rego or Cedar.
