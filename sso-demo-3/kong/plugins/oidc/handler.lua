-- kong-oidc handler, ported to the Kong 3.x plugin interface.
--
-- Upstream nokia/kong-oidc targets Kong 2.x: it did
--   local BasePlugin = require "kong.plugins.base_plugin"
--   local OidcHandler = BasePlugin:extend()
-- but Kong 3.x removed BasePlugin — plugins are now a plain table with phase
-- methods and PRIORITY/VERSION. This file is that port; the behaviour
-- (introspect bearer tokens, else run the OIDC code flow, then inject
-- X-Userinfo / X-Access-Token / X-ID-Token) is unchanged from upstream.
local utils = require("kong.plugins.oidc.utils")
local filter = require("kong.plugins.oidc.filter")
local session = require("kong.plugins.oidc.session")

local OidcHandler = {
  VERSION = "1.2.4-kong3",
  PRIORITY = 1000,
}

local function make_oidc(oidcConfig)
  ngx.log(ngx.DEBUG, "OidcHandler calling authenticate, requested path: " .. ngx.var.request_uri)
  local res, err = require("resty.openidc").authenticate(oidcConfig)
  if err then
    if oidcConfig.recovery_page_path then
      ngx.log(ngx.DEBUG, "Entering recovery page: " .. oidcConfig.recovery_page_path)
      ngx.redirect(oidcConfig.recovery_page_path)
    end
    utils.exit(500, err, ngx.HTTP_INTERNAL_SERVER_ERROR)
  end
  return res
end

local function introspect(oidcConfig)
  if utils.has_bearer_access_token() or oidcConfig.bearer_only == "yes" then
    local res, err = require("resty.openidc").introspect(oidcConfig)
    if err then
      if oidcConfig.bearer_only == "yes" then
        ngx.header["WWW-Authenticate"] = 'Bearer realm="' .. oidcConfig.realm .. '",error="' .. err .. '"'
        utils.exit(ngx.HTTP_UNAUTHORIZED, err, ngx.HTTP_UNAUTHORIZED)
      end
      return nil
    end
    ngx.log(ngx.DEBUG, "OidcHandler introspect succeeded, requested path: " .. ngx.var.request_uri)
    return res
  end
  return nil
end

local function handle(oidcConfig)
  local response
  if oidcConfig.introspection_endpoint then
    response = introspect(oidcConfig)
    if response then
      utils.injectUser(response)
    end
  end

  if response == nil then
    response = make_oidc(oidcConfig)
    if response then
      if response.user then
        utils.injectUser(response.user)
      end
      if response.access_token then
        utils.injectAccessToken(response.access_token)
      end
      if response.id_token then
        utils.injectIDToken(response.id_token)
      end
    end
  end
end

function OidcHandler:access(config)
  local oidcConfig = utils.get_options(config, ngx)

  if filter.shouldProcessRequest(oidcConfig) then
    session.configure(config)
    handle(oidcConfig)
  else
    ngx.log(ngx.DEBUG, "OidcHandler ignoring request, path: " .. ngx.var.request_uri)
  end

  ngx.log(ngx.DEBUG, "OidcHandler done")
end

return OidcHandler
