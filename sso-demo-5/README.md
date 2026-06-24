# sso-demo-5 — Kong OIDC gateway with JavaScript PDK plugin

Kong gateway with a JavaScript OIDC plugin that supports **Keycloak** (dev/staging)
and **Microsoft Entra ID** (production) via a single `OIDC_PROVIDER` flag in `.env`.
No code changes required to switch providers.

## Architecture

```
Browser ──► Kong :8000 ──(JS OIDC plugin: authn, inject X-Userinfo)──► frontend :80
               │                                                         backend :3000 (/api)
               │                                                         Redis :6379
               └──(token exchange)──► Keycloak :8080  (keycloak profile only)
                                      Postgres :5432   (keycloak profile only)
               OR
               └──(token exchange)──► Microsoft Entra ID  (entra profile)
```

## Quick start

```bash
cp .env.example .env          # fill in secrets (defaults work for local Keycloak)
docker compose up --build -d
bash seed/seed-users.sh       # create alice + bob in Keycloak (keycloak profile only)
```

Open **http://localhost:8000** — Kong redirects to the login page.

## Provider selection

Set two variables in `.env`:

| `OIDC_PROVIDER` | `COMPOSE_PROFILES` | What starts |
|---|---|---|
| `keycloak` | `keycloak` | Kong + Redis + frontend + backend + **Postgres + Keycloak** |
| `entra` | *(empty)* | Kong + Redis + frontend + backend only |

### Keycloak (dev / staging)

```dotenv
OIDC_PROVIDER=keycloak
COMPOSE_PROFILES=keycloak
```

Run `bash seed/seed-users.sh` after first start. Keycloak is backed by Postgres so
users and realm config survive restarts.

### Entra ID (production)

1. Register an app in [Azure Portal → App registrations](https://portal.azure.com).
2. Add `<APP_BASE_URL>/oauth2/callback` as a redirect URI.
3. Grant API permissions: `openid`, `profile`, `email`.
4. Fill in `.env`:

```dotenv
OIDC_PROVIDER=entra
COMPOSE_PROFILES=

AZURE_TENANT_ID=<directory-tenant-id>
AZURE_CLIENT_ID=<application-client-id>
AZURE_CLIENT_SECRET=<client-secret-value>

APP_BASE_URL=https://app.example.com
```

## How the provider switch works

`kong/entrypoint.sh` runs at container startup. It reads `OIDC_PROVIDER` and exports
a canonical set of `OIDC_*` env vars before rendering `kong/kong.yml.template` with
`envsubst`:

```
OIDC_PROVIDER=keycloak  →  OIDC_DISCOVERY_URL = ${KC_URL}/realms/${KC_REALM}/...
                            OIDC_CLIENT_ID     = kong
                            OIDC_CLIENT_SECRET = ${KONG_CLIENT_SECRET}
                            OIDC_INTERNAL_HOST = ${KC_INTERNAL_HOST}

OIDC_PROVIDER=entra     →  OIDC_DISCOVERY_URL = https://login.microsoftonline.com/${AZURE_TENANT_ID}/v2.0/...
                            OIDC_CLIENT_ID     = ${AZURE_CLIENT_ID}
                            OIDC_CLIENT_SECRET = ${AZURE_CLIENT_SECRET}
                            OIDC_INTERNAL_HOST = (omitted — Entra is public)
```

`kong.yml.template` only references `OIDC_*` vars, so it needs no changes between providers.

## How the JS PDK plugin works

Kong 3.x supports external plugin servers over a Unix socket. At startup Kong spawns
`kong-js-pluginserver` (from the `kong-pdk` npm package), which loads every plugin
directory under `/usr/local/kong/plugins`.

The OIDC plugin (`kong/plugins/oidc/handler.js`) implements the full authorization
code flow:

1. **Startup** — fetches and caches the provider's OIDC discovery document. Supports
   HTTP and HTTPS. When `internal_host` is set (Keycloak), rewrites only the
   `token_endpoint` host for Docker-internal routing; browser-facing endpoints
   (`authorization_endpoint`, `end_session_endpoint`) are used as-is.
2. **Session check** — reads `oidc_session` cookie, looks up in Redis, injects
   `X-Userinfo` (base64 JSON) and `X-Access-Token` headers, lets the request through.
3. **Callback** (`/oauth2/callback`) — verifies one-time state from Redis, exchanges
   the authorization code for tokens, creates a Redis session (1 h TTL), redirects
   to the original path.
4. **Logout** (`/oauth2/logout`) — deletes the Redis session, clears the cookie,
   builds the provider `end_session_endpoint` URL with `post_logout_redirect_uri`
   (works for both Keycloak and Entra without branching).
5. **Auth redirect** — generates `state` + `nonce`, stores in Redis (10 min TTL),
   redirects to the provider `authorization_endpoint`.

## URLs

| Service | URL |
|---|---|
| App (via Kong) | http://localhost:8000 |
| Keycloak admin | http://localhost:8080 (keycloak profile only) |
| Kong admin API | http://localhost:8001 |

## Demo credentials (Keycloak)

| Username | Password | Roles |
|---|---|---|
| alice | Password123! | admin, user |
| bob | Password123! | user |

Keycloak admin console: **admin / admin** (or as set in `.env`).

## Configuration reference

Copy `.env.example` to `.env`. Key variables:

| Variable | Description |
|---|---|
| `OIDC_PROVIDER` | `keycloak` or `entra` |
| `COMPOSE_PROFILES` | `keycloak` to include Keycloak + Postgres; empty for Entra |
| `KC_URL` | Full public Keycloak URL (e.g. `http://localhost:8080`) |
| `KC_REALM` | Keycloak realm name (default: `demo`) |
| `KC_INTERNAL_HOST` | Docker-internal Keycloak address for token exchange (default: `keycloak:8080`) |
| `KONG_CLIENT_SECRET` | Shared secret between Kong and the Keycloak `kong` client |
| `AZURE_TENANT_ID` | Entra directory (tenant) ID |
| `AZURE_CLIENT_ID` | Entra application (client) ID |
| `AZURE_CLIENT_SECRET` | Entra client secret value |
| `APP_BASE_URL` | Public URL of this app, used in redirect URIs |
| `POSTGRES_PASSWORD` | Postgres password for Keycloak DB |

## Seeding users

```bash
bash seed/seed-users.sh           # from repo root
```

Reads `seed/users.json`. Idempotent — safe to run any number of times. Loads
`.env` from the parent directory automatically.

## Difference from demo 4

| Aspect | demo 4 | demo 5 |
|---|---|---|
| Plugin language | Lua (native Kong plugin) | JavaScript (kong-pdk external server) |
| Session storage | `lua-resty-redis` | `ioredis` npm package |
| Provider support | Keycloak only | Keycloak + Entra ID (flag-switched) |
| Keycloak persistence | In-memory (lost on restart) | Postgres-backed |
| OIDC endpoints | Hardcoded Keycloak paths | Fetched from discovery document |
| Config templating | `kong.yml` (hardcoded secret) | `kong.yml.template` + `envsubst` |
