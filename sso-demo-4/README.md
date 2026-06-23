# SSO Demo 4 — Minimal Keycloak + Kong, with an idempotent user-seeding script

The smallest of the demos: **Keycloak** (OpenID Provider) + **Kong** (gateway,
OIDC plugin = authentication, JavaScript-based) + **Redis** (session storage) +
**one frontend** + **one backend**. No Entra broker, no Postgres, no auth-service.

Users aren't self-registered or brokered — they're created by an **idempotent
script** ([seed-users.sh](seed-users.sh)) against Keycloak's Admin API. Run it as
many times as you like; it converges to the set of users in
[users.json](users.json).

```
 Browser
   │  http://localhost:8000
   ▼
┌──────────────── Kong :8000 ─────────────────────────────────┐
│  oidc plugin (JavaScript) = OIDC client of Keycloak (AUTHZ)  │
│    • no session?  → 302 to Keycloak login                    │
│    • on return    → exchange code, store session in Redis,   │
│                     inject X-Userinfo: base64({email,roles}) │
│  "/" → frontend     "/api" → backend (reads X-Userinfo)      │
└──────────────────┬────────────────┬──────────────────────────┘
                   │                │
      token/jwks   │                └─► Redis :6379
      /userinfo    │                    (session storage)
        (keycloak) │
                   ▼
          Keycloak :8080  ◄── seed-users.sh (Admin API)
```

| | |
|---|---|
| App | http://localhost:8000 |
| Keycloak admin | http://localhost:8080 (`admin` / `admin`) |
| Kong admin API | http://localhost:8001 |
| Redis | localhost:6379 (session store) |

## 1. Run it

> Stop the other demos first — they share ports 8080 / 8000 / 8001.

```bash
cp .env.example .env
docker compose up --build -d        # build Kong (with the OIDC plugin), start all 4 services
./seed-users.sh                     # create the users from users.json
```

`seed-users.sh` waits for Keycloak, then seeds. Open **http://localhost:8000**,
get bounced to Keycloak's login, and sign in as one of the seeded users
(default: `alice` / `Password123!` or `bob` / `Password123!`). Your name, email,
and roles render — read from `/api/me`, which the backend derives purely from the
`X-Userinfo` header Kong injected.

## 2. The idempotent seeding script (the point of this demo)

[seed-users.sh](seed-users.sh) reads [users.json](users.json):

```json
[
  { "username": "alice", "email": "alice@example.com", "firstName": "Alice",
    "lastName": "Admin", "password": "Password123!", "roles": ["admin", "user"] },
  { "username": "bob", "...": "...", "roles": ["user"] }
]
```

For each user it:

1. **Gets an admin token** (password grant against the `master` realm).
2. **Looks the user up** by exact username.
3. **Creates** the user only if missing (skips the create otherwise — no 409s).
4. **Resets the password** to the desired value (idempotent).
5. **Assigns realm roles** (Keycloak ignores roles already assigned — idempotent).

So it's safe to run repeatedly — on a fresh Keycloak it creates everyone; on a
seeded one it's a no-op-equivalent. That matters here because Keycloak runs
`start-dev` **without a database** (in-memory), so users disappear on restart —
and you simply re-run the script (or wire it into your startup).

**Customize:** edit `users.json` (add users, change roles/passwords) and re-run
`./seed-users.sh`. Override targets with env vars, e.g.
`KC_URL=http://localhost:8080 REALM=demo USERS_FILE=staff.json ./seed-users.sh`.

The roles `user` and `admin` are defined in
[keycloak/realm-export.json](keycloak/realm-export.json); add more there if your
`users.json` references them.

## 3. How login works

1. You hit `http://localhost:8000/`; Kong's oidc plugin sees no session cookie and
   **302s to Keycloak**.
2. Keycloak shows its login form (no Register link — `registrationAllowed` is
   off; users come from the script). You sign in as a seeded user.
3. Keycloak redirects to `/oauth2/callback`; Kong exchanges the code
   (server-to-server to `keycloak:8080`), stores the session in **Redis**
   (encrypted, with session ID in a secure cookie), and injects `X-Userinfo` on
   every proxied request.
4. The page calls `/api/me`; the backend decodes `X-Userinfo` and returns the
   profile + roles. **The backend has no auth code.**
5. **Logout** (`/oauth2/logout`) clears the Kong session from Redis and bounces to
   Keycloak's end-session endpoint.

## 4. The issuer/hostname detail

`KC_HOSTNAME=localhost`, so the browser and the token `iss` both use
`http://localhost:8080`. Kong can't reach `localhost` (that's Kong itself), so
the vendored plugin is handed a **split discovery table**: browser-facing URLs
(authorize/logout) stay on `localhost:8080`; server-facing URLs (token/jwks/userinfo)
use `keycloak:8080` (the `internal_host` config). See
[kong/plugins/oidc/utils.js](kong/plugins/oidc/utils.js).

## 5. Troubleshooting

- **Kong: `connection refused` to localhost:8080** — confirm `internal_host:
  keycloak:8080` is set in [kong/kong.yml](kong/kong.yml).
- **`invalid_client` at token exchange** — Kong's `client_secret` in
  `kong/kong.yml` must equal `KONG_CLIENT_SECRET` in `.env` (Kong doesn't read
  `.env`).
- **`seed-users.sh`: can't authenticate** — Keycloak isn't up yet, or the admin
  creds differ. The script retries ~2 min; check `docker compose logs keycloak`.
- **Login form has no users** — you didn't run `./seed-users.sh` (or Keycloak
  restarted and lost them — re-run it).
- **Realm role not found while seeding** — a role in `users.json` isn't defined
  in `realm-export.json`. Add it under `roles.realm`.

## 6. Production caveats (deliberately simplified)

- **No database** — Keycloak's in-memory store loses users on restart; the seed
  script is the workaround. In production use Postgres (see `sso-demo2`/`-3`).
- **Cookie sessions (with Redis) + plain HTTP, `secure=off`, `ssl_verify=no`,
  hardcoded secrets, admin password grant** — all local-only. Behind TLS, with a
  secrets manager and a dedicated seeding service account (not the master admin), in prod.
- **Backend trusts `X-Userinfo`** — safe only because it's reachable solely
  through Kong. Enforce with network policy / mTLS.
- **The kong-oidc plugin is now JavaScript (Kong 3.5+ PDK)**, ported from the
  community Lua plugin and adapted for this demo (see `kong/plugins/oidc/`).
