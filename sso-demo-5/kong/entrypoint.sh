#!/bin/sh
set -e
# Expand only the vars we own; leave any other ${...} in the YAML untouched.
envsubst '${KONG_CLIENT_SECRET} ${KC_URL} ${KC_REALM} ${KC_INTERNAL_HOST} ${APP_BASE_URL}' \
  < /kong/kong.yml.template > /tmp/kong.yml
export KONG_DECLARATIVE_CONFIG=/tmp/kong.yml
exec /docker-entrypoint.sh "$@"
