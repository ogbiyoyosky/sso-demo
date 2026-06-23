# sso-demo-5 — Keycloak + Kong + JavaScript PDK OIDC Plugin

This demo is identical in purpose to `sso-demo-4` (Keycloak as the identity provider,
Kong as the authenticating gateway, Redis for sessions, one frontend, one backend,
idempotent user seeding) but the Kong OIDC plugin is written in **JavaScript** using
the [`kong-js-pdk`](https://github.com/Kong/kong-js-pdk) plugin server instead of Lua.

## Architecture

```
Browser ──► Kong :8000 ──(JS OIDC plugin: authN, inject X-Userinfo)──► frontend :80
               │                                                        backend :3000 (/api)
               └──(token exchange via keycloak:8080)──► Keycloak :8080
                                                        Redis :6379
```

## How the JS PDK plugin works

Kong 3.x supports external plugin servers over a Unix socket. When Kong starts it
spawns the `kong-js-pdk` process, which in turn loads every plugin directory under
`/usr/local/kong/plugins`. For each incoming request Kong calls the plugin's `access`
handler over the socket using a msgpack RPC protocol.

The JS plugin server is configured via environment variables in `docker-compose.yml`:

| Variable | Value |
|---|---|
| `KONG_PLUGINSERVER_NAMES` | `js` |
| `KONG_PLUGINSERVER_JS_SOCKET` | `/usr/local/kong/js_pluginserver.sock` |
| `KONG_PLUGINSERVER_JS_START_CMD` | `kong-js-pdk -d /usr/local/kong/plugins -s <socket>` |
| `KONG_PLUGINSERVER_JS_QUERY_CMD` | `kong-js-pdk -d /usr/local/kong/plugins --dump-all-plugins` |

All Kong PDK calls inside the handler are **async** (`await kong.request.getPath()`,
`await kong.response.exit(...)`, etc.) — the plugin server bridges them back to Kong's
Nginx event loop.

The OIDC plugin itself (`kong/plugins/oidc/handler.js`) implements the full
authorization code flow:

1. **Session check** — reads `oidc_session` cookie, looks up in Redis, injects
   `X-Userinfo` (base64 JSON) and `X-Access-Token` headers, lets the request through.
2. **Callback** (`/oauth2/callback`) — verifies the one-time state from Redis,
   exchanges the code at Keycloak's token endpoint (via the internal Docker hostname
   `keycloak:8080`), creates a Redis session, sets the cookie, redirects to the
   original path.
3. **Logout** (`/oauth2/logout`) — deletes the Redis session, clears the cookie,
   redirects to the Keycloak end-session URL.
4. **Auth redirect** — generates `state` + `nonce`, stores them in Redis (10 min TTL),
   redirects to the Keycloak authorization endpoint (browser-facing `localhost:8080`).

## Difference from demo 4

| Aspect | demo 4 | demo 5 |
|---|---|---|
| Plugin language | Lua (native Kong plugin) | JavaScript (kong-js-pdk external server) |
| Session storage | `lua-resty-redis` via `session.conf` | `ioredis` npm package |
| Kong extra config | `KONG_NGINX_PROXY_INCLUDE`, `session.conf` volume | Plugin server env vars only |
| Kong Dockerfile | Installs Lua rock | Installs Node.js 20 + kong-js-pdk |

The declarative `kong/kong.yml` and all other services (Keycloak, Redis, frontend,
backend) are identical.

## Running

```bash
# 1. Start all services (builds Kong image with Node.js + plugin on first run)
docker compose up --build -d

# 2. Seed demo users into Keycloak (idempotent — safe to run multiple times)
./seed-users.sh
```

## URLs

| Service | URL |
|---|---|
| App (via Kong) | http://localhost:8000 |
| Keycloak admin | http://localhost:8080 |
| Kong admin API | http://localhost:8001 |

## Demo credentials

| Username | Password |
|---|---|
| alice | Password123! |
| bob | Password123! |

Admin console: **admin / admin** (or as configured in `.env`).

## Configuration

Copy `.env.example` to `.env` and adjust values before starting:

```bash
cp .env.example .env
```

The `KONG_CLIENT_SECRET` must match the secret configured for the `kong` client in
the Keycloak realm import (`keycloak/realm-export.json`). The default `change-me-kong-secret`
works out of the box for local development.
