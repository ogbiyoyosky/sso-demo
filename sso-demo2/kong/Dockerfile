# Kong + the community OIDC plugin (github.com/nokia/kong-oidc).
#
# Kong's OSS edition ships no OIDC plugin (it's an Enterprise feature), so we
# bake one in. kong-oidc is a thin wrapper over `lua-resty-openidc`, the de-facto
# OpenResty OIDC library, which in turn uses `lua-resty-session` for the session
# (cookie + optional Redis backing) and `lua-resty-http` for server-to-server
# calls to Keycloak.
#
# Versions are PINNED on purpose: lua-resty-session changed its configuration
# model completely in v4 (no more $session_* nginx variables). We pin v3.x so
# the $session_* knobs in session.conf actually take effect (see README §3).
FROM kong:3.4-ubuntu

USER root

# luarocks needs a compiler toolchain to build the C parts of these rocks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git unzip build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN luarocks install lua-resty-session 3.10 \
    && luarocks install lua-resty-openidc 1.7.6 \
    && luarocks install kong-oidc 1.2.4-1

USER kong
