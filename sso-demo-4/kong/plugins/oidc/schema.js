/**
 * schema.js - Kong OIDC plugin configuration schema
 *
 * Defines the plugin's configuration fields and validation.
 */

module.exports = {
  name: "oidc",
  fields: [
    {
      config: {
        type: "record",
        fields: [
          {
            client_id: {
              type: "string",
              required: true,
              description: "OIDC Client ID",
            },
          },
          {
            client_secret: {
              type: "string",
              required: true,
              description: "OIDC Client Secret",
            },
          },
          {
            discovery: {
              type: "string",
              required: true,
              default: "https://.well-known/openid-configuration",
              description: "OpenID Provider discovery URL or metadata table",
            },
          },
          {
            internal_host: {
              type: "string",
              required: false,
              description:
                "Internal hostname for server-side calls (e.g., keycloak:8080)",
            },
          },
          {
            introspection_endpoint: {
              type: "string",
              required: false,
              description: "Token introspection endpoint URL",
            },
          },
          {
            timeout: {
              type: "number",
              required: false,
              description: "Request timeout in milliseconds",
            },
          },
          {
            introspection_endpoint_auth_method: {
              type: "string",
              required: false,
              description: "Authentication method for introspection endpoint",
            },
          },
          {
            bearer_only: {
              type: "string",
              required: true,
              default: "no",
              description: "Enable bearer token only mode",
            },
          },
          {
            realm: {
              type: "string",
              required: true,
              default: "kong",
              description: "OIDC realm name",
            },
          },
          {
            redirect_uri_path: {
              type: "string",
              required: false,
              description: "Redirect URI path (callback)",
            },
          },
          {
            scope: {
              type: "string",
              required: true,
              default: "openid",
              description: "OIDC scopes to request",
            },
          },
          {
            response_type: {
              type: "string",
              required: true,
              default: "code",
              description: "OIDC response type",
            },
          },
          {
            ssl_verify: {
              type: "string",
              required: true,
              default: "no",
              description: "Verify SSL certificates",
            },
          },
          {
            token_endpoint_auth_method: {
              type: "string",
              required: true,
              default: "client_secret_post",
              description: "Token endpoint authentication method",
            },
          },
          {
            session_secret: {
              type: "string",
              required: false,
              description: "Session encryption secret (base64 encoded)",
            },
          },
          {
            recovery_page_path: {
              type: "string",
              required: false,
              description: "Recovery page path on authentication failure",
            },
          },
          {
            logout_path: {
              type: "string",
              required: false,
              default: "/logout",
              description: "Logout endpoint path",
            },
          },
          {
            redirect_after_logout_uri: {
              type: "string",
              required: false,
              default: "/",
              description: "Redirect URI after logout",
            },
          },
          {
            filters: {
              type: "string",
              required: false,
              description: "Comma-separated request path patterns to skip",
            },
          },
        ],
      },
    },
  ],
};
