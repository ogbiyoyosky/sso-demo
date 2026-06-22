# Kong + the community OIDC plugin (github.com/nokia/kong-oidc), ported to Kong 3.x.
#
# Two wrinkles, both handled here:
#
# 1. luarocks on this image (Lua 5.1 / LuaJIT) CANNOT load luarocks.org's
#    aggregated manifest — it errors with "main function has more than 65536
#    constants". So we install the Lua deps by DIRECT .src.rock URL with
#    --deps-mode=none, which never touches the manifest. (resty.http and
#    resty.session are bundled in Kong; resty.hmac comes with jwt.)
#
# 2. The kong-oidc *plugin* (nokia) targets Kong 2.x — its handler requires the
#    removed `kong.plugins.base_plugin`, and its schema uses the old flat format.
#    We vendor a Kong-3.x-ported copy from this repo (see kong/plugins/oidc/).
#
# lua-resty-session is pinned to 3.10 because lua-resty-openidc 1.7.6 targets the
# v3 API and our session.conf uses v3's $session_* nginx variables for Redis.
FROM kong:3.4-ubuntu

USER root

# OIDC Lua dependency chain (direct URLs → no luarocks manifest involved).
RUN luarocks install https://luarocks.org/lua-resty-session-3.10-1.src.rock --deps-mode=none \
 && luarocks install https://luarocks.org/lua-resty-jwt-0.2.3-0.src.rock --deps-mode=none \
 && luarocks install https://luarocks.org/lua-resty-openidc-1.7.6-1.src.rock --deps-mode=none

# Vendor our Kong-3.x-ported kong-oidc plugin (provides the `oidc` plugin).
COPY plugins/oidc /usr/local/share/lua/5.1/kong/plugins/oidc

USER kong
