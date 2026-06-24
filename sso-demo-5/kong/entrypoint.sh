#!/bin/sh
set -e

# Resolve generic OIDC_* vars from provider-specific vars.
# kong.yml.template consumes only OIDC_* so it stays provider-agnostic.
OIDC_PROVIDER="${OIDC_PROVIDER:-keycloak}"

if [ "$OIDC_PROVIDER" = "entra" ]; then
  export OIDC_DISCOVERY_URL="https://login.microsoftonline.com/${AZURE_TENANT_ID}/v2.0/.well-known/openid-configuration"
  export OIDC_CLIENT_ID="$AZURE_CLIENT_ID"
  export OIDC_CLIENT_SECRET="$AZURE_CLIENT_SECRET"
  export OIDC_INTERNAL_HOST=""
  export OIDC_SCOPE="${OIDC_SCOPE:-openid profile email}"
else
  # keycloak (default)
  export OIDC_DISCOVERY_URL="${KC_URL}/realms/${KC_REALM}/.well-known/openid-configuration"
  export OIDC_CLIENT_ID="kong"
  export OIDC_CLIENT_SECRET="$KONG_CLIENT_SECRET"
  export OIDC_INTERNAL_HOST="${KC_INTERNAL_HOST:-keycloak:8080}"
  export OIDC_SCOPE="${OIDC_SCOPE:-openid profile email}"
fi

# Expand only the vars we own; leave any other ${...} in the YAML untouched.
# Then drop the internal_host line entirely if it resolved to empty string —
# Kong's schema requires length >= 1, so the field must be absent, not blank.
envsubst '${OIDC_DISCOVERY_URL} ${OIDC_CLIENT_ID} ${OIDC_CLIENT_SECRET} ${OIDC_INTERNAL_HOST} ${OIDC_SCOPE} ${APP_BASE_URL}' \
  < /kong/kong.yml.template \
  | sed '/internal_host: ""/d' \
  > /tmp/kong.yml

export KONG_DECLARATIVE_CONFIG=/tmp/kong.yml
exec /docker-entrypoint.sh "$@"
