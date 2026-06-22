local cjson = require("cjson")

local M = {}

local function parseFilters(csvFilters)
  local filters = {}
  if (not (csvFilters == nil)) then
    for pattern in string.gmatch(csvFilters, "[^,]+") do
      table.insert(filters, pattern)
    end
  end
  return filters
end

function M.get_redirect_uri_path(ngx)
  local function drop_query()
    local uri = ngx.var.request_uri
    local x = uri:find("?")
    if x then
      return uri:sub(1, x - 1)
    else
      return uri
    end
  end

  local function tackle_slash(path)
    local args = ngx.req.get_uri_args()
    if args and args.code then
      return path
    elseif path == "/" then
      return "/cb"
    elseif path:sub(-1) == "/" then
      return path:sub(1, -2)
    else
      return path .. "/"
    end
  end

  return tackle_slash(drop_query())
end

function M.get_options(config, ngx)
  local opts = {
    client_id = config.client_id,
    client_secret = config.client_secret,
    discovery = config.discovery,
    introspection_endpoint = config.introspection_endpoint,
    timeout = config.timeout,
    introspection_endpoint_auth_method = config.introspection_endpoint_auth_method,
    bearer_only = config.bearer_only,
    realm = config.realm,
    redirect_uri_path = config.redirect_uri_path or M.get_redirect_uri_path(ngx),
    scope = config.scope,
    response_type = config.response_type,
    ssl_verify = config.ssl_verify,
    token_endpoint_auth_method = config.token_endpoint_auth_method,
    recovery_page_path = config.recovery_page_path,
    filters = parseFilters(config.filters),
    logout_path = config.logout_path,
    redirect_after_logout_uri = config.redirect_after_logout_uri,
  }

  -- ISSUER/HOSTNAME SPLIT (the Docker + OIDC pitfall, solved for Kong).
  -- The browser reaches Keycloak at the issuer host (localhost:8080) but THIS
  -- container can't (its localhost is Kong itself), and lua-resty-openidc has no
  -- per-request URL-rewrite hook. However, if opts.discovery is a TABLE it skips
  -- the discovery fetch and uses the table verbatim. So when `internal_host` is
  -- set we hand it a hand-built metadata table:
  --   • browser-facing endpoints (authorization, end_session) keep the issuer
  --     host → the BROWSER reaches them and the id_token `iss` matches.
  --   • server-facing endpoints (token, userinfo, jwks) use internal_host
  --     → KONG reaches Keycloak over the compose network.
  -- (Endpoint paths follow Keycloak's standard layout.)
  if config.internal_host and config.internal_host ~= "" then
    local issuer_base = config.discovery:gsub("/%.well%-known/openid%-configuration$", "")
    local path = issuer_base:match("^https?://[^/]+(.*)$") or ""
    local internal_base = "http://" .. config.internal_host .. path
    opts.discovery = {
      issuer = issuer_base,
      authorization_endpoint       = issuer_base .. "/protocol/openid-connect/auth",
      end_session_endpoint         = issuer_base .. "/protocol/openid-connect/logout",
      token_endpoint               = internal_base .. "/protocol/openid-connect/token",
      token_introspection_endpoint = internal_base .. "/protocol/openid-connect/token/introspect",
      userinfo_endpoint            = internal_base .. "/protocol/openid-connect/userinfo",
      jwks_uri                     = internal_base .. "/protocol/openid-connect/certs",
    }
  end

  return opts
end

function M.exit(httpStatusCode, message, ngxCode)
  ngx.status = httpStatusCode
  ngx.say(message)
  ngx.exit(ngxCode)
end

function M.injectAccessToken(accessToken)
  ngx.req.set_header("X-Access-Token", accessToken)
end

function M.injectIDToken(idToken)
  local tokenStr = cjson.encode(idToken)
  ngx.req.set_header("X-ID-Token", ngx.encode_base64(tokenStr))
end

function M.injectUser(user)
  local tmp_user = user
  tmp_user.id = user.sub
  tmp_user.username = user.preferred_username
  ngx.ctx.authenticated_credential = tmp_user
  local userinfo = cjson.encode(user)
  ngx.req.set_header("X-Userinfo", ngx.encode_base64(userinfo))
end

function M.has_bearer_access_token()
  local header = ngx.req.get_headers()['Authorization']
  if header and header:find(" ") then
    local divider = header:find(' ')
    if string.lower(header:sub(0, divider-1)) == string.lower("Bearer") then
      return true
    end
  end
  return false
end

return M
