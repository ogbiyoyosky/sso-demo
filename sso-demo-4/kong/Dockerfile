FROM kong:3.5-ubuntu

USER root

# lua-resty-openidc vendored directly — avoids luarocks.org manifest lookup
# which breaks under Lua 5.1's 65536 constant limit. Kong already ships all
# required deps: lua-resty-http, lua-resty-session, lua-cjson.
COPY lua-vendor/resty/openidc.lua /usr/local/share/lua/5.1/resty/openidc.lua

# Copy the Lua OIDC plugin into Kong's plugin directory
RUN mkdir -p /usr/local/share/lua/5.1/kong/plugins/oidc
COPY plugins/oidc/schema.lua  /usr/local/share/lua/5.1/kong/plugins/oidc/schema.lua
COPY plugins/oidc/handler.lua /usr/local/share/lua/5.1/kong/plugins/oidc/handler.lua

USER kong
