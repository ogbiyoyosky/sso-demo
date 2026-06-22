# OIDC SSO Demo 2 — Authentication at the Gateway (Kong + Redis + Postgres)

A runnable learning project that moves OpenID Connect **out of the apps and up
into an API gateway**. Where [`../sso-demo`](../sso-demo) made each backend its
own OIDC client, here **Kong** is the single OIDC client, sessions live in
**Redis**, every user lives in **Postgres**, and the apps behind Kong contain
*zero* authentication code.

```
 Browser
   │  http://app-one.localhost:8000          http://app-two.localhost:8000
   ▼
┌──────────────────────── Kong Gateway :8000 ────────────────────────────┐
│  kong-oidc plugin  =  confidential OIDC client of Keycloak              │
│    • no session?  → redirect browser to Keycloak login                  │
│    • on return    → exchange code, store session in REDIS               │
│    • every proxied request → inject  X-Userinfo: base64({email,roles…}) │
└───┬───────────────────────────────────────────────┬────────────────────┘
    ▼ (frontend, public page)                        ▼ (/api, identity header)
 frontend1 / frontend2  (nginx, static)        backend1 / backend2  (Express,
                                                role-aware, NO auth code)
                  ▲ server-to-server: discovery, token, userinfo, jwks
                  │
            Keycloak :8080  ── identity broker ──►  Microsoft Entra ID
              realm "demo"                            (cloud, manual setup)
              ├─ "Login with Microsoft"  → in-house users → role: employee
              └─ "Register" (email + pw) → outside users  → role: customer
                  │
                  ▼
            Postgres :5432   ← ALL users (brokered + self-registered) persisted

            Redis :6379      ← Kong's OIDC sessions (shared / "sticky")
```

**What each requirement maps to**

| You asked for | Where it lives |
|---|---|
| Kong + an OIDC plugin | `kong/` — custom Kong image with the `kong-oidc` plugin |
| Redis for sticky sessions | `kong/session.conf` — lua-resty-session stores OIDC sessions in Redis |
| Two frontends + two backends | `frontend/` + `backend/`, each built twice (App One / App Two) |
| Entra for in-house users, **with roles** | Keycloak brokers to Entra; a hardcoded IdP mapper grants `employee` |
| Outside users register with email + password | Keycloak self-registration (`registrationAllowed`) → role `customer` |
| Postgres to save all users | Keycloak runs with `KC_DB=postgres`; every account is stored there |

---

## 1. Entra ID setup (the only manual part)

This stack uses the **same realm name (`demo`) and IdP alias (`microsoft`)** as
`../sso-demo`, so the broker redirect URI is identical. **If you already did the
Entra setup for `sso-demo`, you are done — the same app registration works here**
and the `.env` in this folder is pre-filled with those credentials.

If starting fresh, register an app in [Entra](https://portal.azure.com)
(**Microsoft Entra ID → App registrations → New registration**):

- **Supported account types:** single tenant.
- **Redirect URI** (platform **Web**), exactly:
  ```
  http://localhost:8080/realms/demo/broker/microsoft/endpoint
  ```
  This is Keycloak's broker endpoint — Microsoft returns the user *here*, to
  Keycloak, never to Kong or the apps. Entra permits plain `http` only because
  the host is literally `localhost`.
- Copy **Application (client) ID** → `ENTRA_CLIENT_ID`, **Directory (tenant) ID**
  → `ENTRA_TENANT_ID`, and a new **client secret value** → `ENTRA_CLIENT_SECRET`
  into `.env`.

## 2. Run it

> If `../sso-demo` is running, stop it first — both stacks publish ports 8080.

```bash
cp .env.example .env       # (this folder already ships a filled-in .env)
# edit .env if you need your own ENTRA_* values
docker compose up --build
```

The first build compiles the `kong-oidc` plugin from LuaRocks (~1–2 min).
Keycloak then boots, migrates its Postgres schema, and imports the realm (~40s).
Wait for Kong to report it loaded the `oidc` plugin and for:

```
keycloak-1  | ... Imported realm demo
kong-1      | ... finished preloading 'oidc' ... / Kong started
```

| What | URL | Notes |
|---|---|---|
| App One — Customer Portal | http://app-one.localhost:8000 | any authenticated user |
| App Two — Internal Tools | http://app-two.localhost:8000 | **employees only** |
| Keycloak admin console | http://localhost:8080 | `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` |
| Kong admin API | http://localhost:8001 | `curl localhost:8001` to inspect routes/plugins |

> **`*.localhost` hostnames:** Chrome, Firefox, Safari and Edge resolve
> `app-one.localhost`/`app-two.localhost` to `127.0.0.1` automatically — no
> hosts-file edit needed. If your browser somehow doesn't, add
> `127.0.0.1 app-one.localhost app-two.localhost` to `/etc/hosts`.

## 3. The two onboarding paths (the core of the demo)

Open **http://app-one.localhost:8000**. Because Kong guards even the front page,
you can't see the app without a session — you're bounced straight to Keycloak's
login screen, which offers **both** paths:

- **In-house users** click **Microsoft Entra ID** → sign in with their work
  account. Keycloak brokers the login, creates/updates a local Keycloak user,
  and the *grant-employee-role* IdP mapper stamps them with the **`employee`**
  role. → "in-house users use Entra, with roles."
- **Outside users** click **Register**, create an account with **email +
  password**, and land back in the app. New accounts get the **`customer`** role
  via the realm's default role. → "outside users register with email + password."

Either way, Keycloak persists the account to **Postgres**, Kong stores the
session in **Redis**, and the app's page shows your name, email, roles, and which
path you came in through.

### How a single login actually flows

1. Browser hits `http://app-one.localhost:8000/` with no session cookie.
2. Kong's `oidc` plugin (lua-resty-openidc) starts an Authorization Code flow and
   **redirects the browser to Keycloak** (`authorization_endpoint`, discovered).
3. Keycloak shows its login page (Microsoft button + username/password +
   Register). The user picks a path and authenticates. For the Microsoft path,
   Keycloak runs its *own* second code flow against Entra (it is brokering).
4. Keycloak redirects the browser back to **`/cb`** on Kong with a code.
5. Kong matches `/cb` to the route, the plugin **exchanges the code** for tokens
   (server-to-server to Keycloak), **fetches userinfo**, and writes a session
   whose payload lives in **Redis** (only the session id rides in the cookie).
6. Kong redirects the browser to the originally requested URL (`/`). This time
   the session exists, so the request passes through to the frontend, and Kong
   **injects `X-Userinfo`** (base64 JSON of the userinfo claims, including
   `roles`) on every proxied call.
7. The page calls **`/api/me`** (same origin → cookie sent automatically). Kong
   validates the session and forwards the request to the backend *with*
   `X-Userinfo`. The backend decodes it, applies its role check, and returns the
   profile. No tokens, no sessions, no OIDC code in the backend at all.

### Roles in action — the two-app difference

- **App One (Customer Portal)** sets `REQUIRED_ROLE=""` → any authenticated user
  is allowed (employees and customers both get in).
- **App Two (Internal Tools)** sets `REQUIRED_ROLE=employee`. A customer who
  signs in is **authenticated by Kong but rejected by the app** with `403` — the
  page shows "Access denied — requires the employee role." That split is the
  lesson: **Kong does authentication (are you logged in?), the app does
  authorization (do you have the role?).**

  Try it: register a customer account and open App Two → denied. Log in through
  Microsoft → allowed.

## 3b. Seeing single sign-on — the two-app test

App One and App Two are **separate Kong clients on separate hostnames**, so their
session cookies are independent (browsers scope cookies by host). But they share
**one Keycloak SSO session**. So:

1. Log in to **App One** (Microsoft or register). You're in.
2. Open **App Two**. Its own cookie doesn't exist yet → Kong starts a login →
   but the browser still holds Keycloak's SSO session from step 1, so Keycloak
   issues a code **with no prompt** → you're in instantly. *That silent step is
   SSO.* (For App Two you must be an `employee`, or you'll authenticate silently
   and then be 403'd — still proving the SSO session was reused.)
3. **Logout** from either app (`/logout`) clears that app's Redis session **and**
   ends the Keycloak SSO session (RP-initiated logout with `id_token_hint`), so
   the next login prompts again. The other app's *local* session survives until
   its cookie/Redis entry expires — cross-app single-logout is out of scope.

## 3c. Why Redis = "sticky" / shared sessions

The plugin could encrypt the whole session into the cookie. Instead
(`kong/session.conf`) it stores only a session **id** in the cookie and keeps the
payload (tokens, userinfo) in **Redis**. Why that matters: if you ran several
Kong replicas behind a load balancer, a cookie-only session would be readable
only by the node that minted it — you'd need the LB to pin ("stick") each user to
one node. With the session in Redis, **any** Kong node can resolve **any**
session, so the load balancer is free and a node can die without logging users
out. Inspect it live:

```bash
docker compose exec redis redis-cli --scan --pattern 'oidc:*'
```

## 4. The issuer/hostname problem (read before debugging `iss` errors!)

OIDC tokens embed the issuer (`iss`), and the client must validate it — so the
URL the **browser** uses for Keycloak and the URL **Kong** uses server-to-server
must produce the *same* issuer string. Two competing constraints:

- **Entra** only allows a plain-`http` redirect URI when the host is literally
  `localhost`. → Keycloak's issuer must be `http://localhost:8080/...`, so
  `KC_HOSTNAME=localhost`.
- **Kong**, inside the compose network, can't reach `localhost:8080` (that's its
  own container) — it would normally use `keycloak:8080`. But if it discovered
  Keycloak under `keycloak:8080`, the discovered endpoints (and the `iss` it
  expects) would say `keycloak:8080`, mismatching the tokens.

This stack resolves it by making Kong's `localhost` mean *the host machine*:

```yaml
kong:
  extra_hosts:
    - "localhost:host-gateway"
```

Now `http://localhost:8080` resolves, from inside Kong, to the host where
Keycloak's `8080` is published — the **same** URL the browser uses and the
**same** issuer the tokens carry. One issuer string everywhere.

> `../sso-demo` instead kept `keycloak:8080` for transport and rewrote the host
> in a `customFetch` hook (because `openid-client` exposes one). lua-resty-openidc
> has no such hook, so here we use the `host-gateway` approach that sso-demo's
> README mentions as the alternative. The trade-off: Kong's healthcheck must use
> the numeric `127.0.0.1` (not the name `localhost`, which we've remapped) — and
> it does (`kong health`).

## 5. Troubleshooting

**Kong fails to start: `plugin 'oidc' not found` / `module 'resty.openidc'`**
The LuaRocks build didn't complete. Rebuild without cache:
`docker compose build --no-cache kong`. Confirm `KONG_PLUGINS=bundled,oidc` is
set (it is, in compose).

**Sessions not landing in Redis (cookie-only, or "session secret" warnings)**
The `$session_*` variables are only read by **lua-resty-session v3** — which is
why `kong/Dockerfile` pins `lua-resty-session 3.10`. If you bumped it to v4, the
Redis config in `kong/session.conf` is silently ignored (v4 dropped the nginx-var
config model). Check the keys exist:
`docker compose exec redis redis-cli keys 'oidc:*'`.

**`AADSTS50011: redirect URI does not match`**
The Entra app registration's redirect URI must be byte-for-byte
`http://localhost:8080/realms/demo/broker/microsoft/endpoint`, under the **Web**
platform.

**Token exchange fails: `invalid_client` / `unauthorized_client`**
Kong's `client_secret` in `kong/kong.yml` must equal Keycloak's client secret
(imported from `KONG_APP_ONE_SECRET`/`KONG_APP_TWO_SECRET` in `.env`). Kong does
**not** read `.env`, so if you changed the secret you must edit both files. After
editing the realm, wipe Keycloak state so the import re-runs:
`docker compose down -v && docker compose up --build`.

**`unexpected JWT "iss"` / discovery refused / redirect loop to Keycloak**
The issuer/hostname problem in §4. Verify `KC_HOSTNAME=localhost`, that the
`oidc` `discovery` URL is `http://localhost:8080/...`, and that Kong has
`extra_hosts: ["localhost:host-gateway"]`.

**App Two always says "Access denied"**
You're signed in as a `customer`, not an `employee`. Only the Microsoft/Entra
path grants `employee`. Check the decoded roles on the page, or in the Keycloak
admin console → Users → (your user) → Role mapping.

**Changed `realm-export.json` but nothing changed**
`--import-realm` skips realms that already exist *and* Postgres persists them, so
a plain restart keeps the old realm. Wipe volumes:
`docker compose down -v && docker compose up --build`.

## 6. Production caveats (deliberately simplified here)

- **The backend trusts `X-Userinfo` blindly.** That's only safe because the
  backends are unpublished (reachable only through Kong, which overwrites the
  header). In production, enforce that boundary with network policy / mTLS so no
  one can call a backend directly and forge identity.
- **Plain HTTP**, `secure=off` cookies, `ssl_verify=no`, `start-dev` Keycloak —
  all local-only. Behind TLS, flip every one of these.
- **Hardcoded secrets** in `kong/kong.yml` and `.env`. Use Kong's environment/
  Vault references and a real secrets manager for deployments.
- **Single Redis / single Postgres / single Kong** — no HA. The Redis session
  store is the piece that *makes* HA possible (§3c), but you'd still cluster all
  three.
- **`kong-oidc` is a community plugin.** Kong's first-party OIDC plugin is an
  Enterprise feature; for OSS this (lua-resty-openidc-based) plugin is the common
  choice, and it's version-sensitive (see §5).
- **Coarse roles.** Every Entra user becomes an `employee`. Real deployments map
  Entra **groups/app roles** to fine-grained Keycloak roles via a claim mapper
  instead of one hardcoded role.
