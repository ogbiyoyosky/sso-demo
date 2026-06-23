#!/usr/bin/env bash
#
# Idempotent Keycloak user seeder.
#
# Reads users.json and converges Keycloak's realm to that exact set of users via
# the Admin REST API: creates missing users, (re)sets their password, and ensures
# their realm roles are assigned. Safe to run any number of times — running it
# again changes nothing if the users already match.
#
#   ./seed-users.sh                 # uses defaults below (+ .env if present)
#   USERS_FILE=other.json ./seed-users.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# Pick up KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD / KONG_CLIENT_SECRET from .env
# if it's there, so the admin creds match the running stack.
if [ -f .env ]; then set -a; . ./.env; set +a; fi

export KC_URL="${KC_URL:-http://localhost:8080}"
export REALM="${REALM:-demo}"
export KEYCLOAK_ADMIN="${KEYCLOAK_ADMIN:-admin}"
export KEYCLOAK_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
export USERS_FILE="${USERS_FILE:-$PWD/users.json}"

command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }

# The Admin-API logic lives in Python (stdlib only) — far cleaner for JSON + the
# upsert/idempotency than bash + curl.
exec python3 - <<'PY'
import os, json, time, urllib.request, urllib.parse, urllib.error

KC    = os.environ["KC_URL"].rstrip("/")
REALM = os.environ["REALM"]
AUSER = os.environ["KEYCLOAK_ADMIN"]
APASS = os.environ["KEYCLOAK_ADMIN_PASSWORD"]
UFILE = os.environ["USERS_FILE"]

def http(method, url, token=None, data=None, form=False):
    headers, body = {}, None
    if form:
        body = urllib.parse.urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode() or ""
            ct = r.headers.get("content-type", "")
            return r.status, (json.loads(raw) if raw and ct.startswith("application/json") else raw)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def get_token():
    s, d = http("POST", f"{KC}/realms/master/protocol/openid-connect/token", form=True,
                data={"grant_type": "password", "client_id": "admin-cli",
                      "username": AUSER, "password": APASS})
    return d["access_token"] if s == 200 else None

# Wait for Keycloak's admin API to answer (it boots + imports the realm first).
print(f"Waiting for Keycloak at {KC} ...")
token = None
for _ in range(60):
    token = get_token()
    if token:
        break
    time.sleep(2)
if not token:
    raise SystemExit("ERROR: could not authenticate to the Keycloak admin API")

base = f"{KC}/admin/realms/{REALM}"

def find_user_id(username):
    s, d = http("GET", f"{base}/users?username={urllib.parse.quote(username)}&exact=true", token)
    return d[0]["id"] if s == 200 and isinstance(d, list) and d else None

def role_rep(name):
    s, d = http("GET", f"{base}/roles/{urllib.parse.quote(name)}", token)
    if s == 200:
        return {"id": d["id"], "name": d["name"]}
    print(f"     ! realm role '{name}' not found — skipping")
    return None

users = json.load(open(UFILE))
print(f"Seeding {len(users)} user(s) into realm '{REALM}':\n")
for u in users:
    un = u["username"]
    uid = find_user_id(un)
    if uid:
        action = "exists "
    else:
        s, _ = http("POST", f"{base}/users", token, data={
            "username": un, "email": u.get("email"),
            "firstName": u.get("firstName"), "lastName": u.get("lastName"),
            "enabled": True, "emailVerified": True,
        })
        if s not in (201, 204):
            print(f"  ✗ {un}: create failed (HTTP {s})")
            continue
        uid = find_user_id(un)
        action = "created"

    # Password — idempotent (sets it to the desired value every run).
    http("PUT", f"{base}/users/{uid}/reset-password", token,
         data={"type": "password", "value": u["password"], "temporary": False})

    # Realm roles — idempotent (Keycloak ignores roles already assigned).
    reps = [r for r in (role_rep(n) for n in u.get("roles", [])) if r]
    if reps:
        http("POST", f"{base}/users/{uid}/role-mappings/realm", token, data=reps)

    print(f"  ✓ {un:<20} [{action}]  roles: {', '.join(u.get('roles', [])) or '-'}")

print("\nDone. Re-run any time — the result is the same (idempotent).")
PY
