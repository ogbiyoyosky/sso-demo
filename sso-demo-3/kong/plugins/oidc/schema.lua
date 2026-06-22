-- kong-oidc schema, rewritten in the Kong 3.x "record" format.
--
-- Upstream's schema used the Kong 2.x flat style (`return { fields = { client_id
-- = {...}, ... } }`), which Kong 3.x rejects. Kong 3.x wants a named plugin with
-- a single `config` record field. The field set below matches exactly what
-- utils.get_options() reads, so config validation and the handler stay in sync.
return {
  name = "oidc",
  fields = {
    {
      config = {
        type = "record",
        fields = {
          { client_id = { type = "string", required = true } },
          { client_secret = { type = "string", required = true } },
          { discovery = { type = "string", required = true, default = "https://.well-known/openid-configuration" } },
          -- Non-standard field added for this demo: the host (e.g. keycloak:8080)
          -- Kong should use for SERVER-SIDE OIDC calls, while browser-facing URLs
          -- keep the discovery/issuer host. See utils.get_options.
          { internal_host = { type = "string", required = false } },
          { introspection_endpoint = { type = "string", required = false } },
          { timeout = { type = "number", required = false } },
          { introspection_endpoint_auth_method = { type = "string", required = false } },
          { bearer_only = { type = "string", required = true, default = "no" } },
          { realm = { type = "string", required = true, default = "kong" } },
          -- PATH (not full URL) the IdP redirects back to; openidc builds the
          -- full redirect_uri from the request's scheme+host + this path.
          { redirect_uri_path = { type = "string" } },
          { scope = { type = "string", required = true, default = "openid" } },
          { response_type = { type = "string", required = true, default = "code" } },
          { ssl_verify = { type = "string", required = true, default = "no" } },
          { token_endpoint_auth_method = { type = "string", required = true, default = "client_secret_post" } },
          { session_secret = { type = "string", required = false } },
          { recovery_page_path = { type = "string" } },
          { logout_path = { type = "string", required = false, default = "/logout" } },
          { redirect_after_logout_uri = { type = "string", required = false, default = "/" } },
          { filters = { type = "string" } },
        },
      },
    },
  },
}
