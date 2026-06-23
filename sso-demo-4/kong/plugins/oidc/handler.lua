local openidc = require("resty.openidc")
local cjson   = require("cjson")

local OidcHandler = {}
OidcHandler.PRIORITY = 1000
OidcHandler.VERSION  = "1.0.0"

local function parse_filters(csv)
  if not csv or csv == "" then return {} end
  local t = {}
  for f in csv:gmatch("[^,]+") do
    t[#t + 1] = f:match("^%s*(.-)%s*$")
  end
  return t
end

local function should_skip(filters)
  if #filters == 0 then return false end
  local path = kong.request.get_path()
  for _, pattern in ipairs(filters) do
    if path:find(pattern, 1, true) then return true end
  end
  return false
end

local function build_opts(config)
  local opts = {
    client_id              = config.client_id,
    client_secret          = config.client_secret,
    discovery              = config.discovery,
    redirect_uri_path      = config.redirect_uri_path,
    scope                  = config.scope,
    response_type          = config.response_type,
    ssl_verify             = (config.ssl_verify == "yes"),
    token_endpoint_auth_method = config.token_endpoint_auth_method,
    logout_path            = config.logout_path,
    redirect_after_logout_uri  = config.redirect_after_logout_uri,
    redirect_after_logout_with_id_token_hint = false,
    session_contents       = { id_token = true, access_token = true },
    -- Redis session storage configured programmatically (works with lua-resty-session v3 and v4)
    session_opts = {
      storage = "redis",
      redis   = { host = "redis", port = 6379, database = 0 },
      cookie  = { secure = false, http_only = true, same_site = "Lax" },
      secret  = "demo4-kong-oidc-session-secret-change-me",
    },
  }

  if config.introspection_endpoint and config.introspection_endpoint ~= "" then
    opts.introspection_endpoint = config.introspection_endpoint
    opts.introspection_endpoint_auth_method = config.introspection_endpoint_auth_method
  end
  if config.timeout then
    opts.timeout = config.timeout
  end

  -- Split discovery: browser-facing URLs stay on issuer host; Kong-internal calls
  -- (token exchange, JWKS, userinfo) use internal_host to bypass localhost routing.
  if config.internal_host and config.internal_host ~= "" then
    local issuer     = config.discovery:gsub("/%.well%-known/openid%-configuration$", "")
    local realm_path = issuer:match("^https?://[^/]*(/.+)$") or ""
    local internal   = "http://" .. config.internal_host .. realm_path

    opts.discovery = {
      issuer                       = issuer,
      authorization_endpoint       = issuer   .. "/protocol/openid-connect/auth",
      end_session_endpoint         = issuer   .. "/protocol/openid-connect/logout",
      token_endpoint               = internal .. "/protocol/openid-connect/token",
      token_introspection_endpoint = internal .. "/protocol/openid-connect/token/introspect",
      userinfo_endpoint            = internal .. "/protocol/openid-connect/userinfo",
      jwks_uri                     = internal .. "/protocol/openid-connect/certs",
      response_types_supported     = { "code" },
    }
  end

  return opts
end

function OidcHandler:access(config)
  if should_skip(parse_filters(config.filters)) then return end

  local opts = build_opts(config)
  local res, err = openidc.authenticate(opts)

  if err then
    if config.recovery_page_path and config.recovery_page_path ~= "" then
      return kong.response.exit(302, "", { Location = config.recovery_page_path })
    end
    kong.log.err("oidc: ", err)
    return kong.response.exit(500, "OIDC error: " .. tostring(err))
  end

  if res then
    if res.user then
      kong.service.request.set_header(
        "X-Userinfo",
        ngx.encode_base64(cjson.encode(res.user))
      )
    end
    if res.access_token then
      kong.service.request.set_header("X-Access-Token", res.access_token)
    end
    if res.id_token then
      kong.service.request.set_header(
        "X-ID-Token",
        ngx.encode_base64(cjson.encode(res.id_token))
      )
    end
  end
end

return OidcHandler
