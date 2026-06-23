/**
 * utils.js - Utility functions for OIDC plugin
 */

const cjson = require("cjson");

function parseFilters(csvFilters) {
  if (!csvFilters) {
    return [];
  }
  return csvFilters.split(",").map((f) => f.trim());
}

function getRedirectUriPath() {
  const uri = kong.request.get_path_with_query();
  let path = uri.split("?")[0];

  const args = kong.request.get_query();
  if (args && args.code) {
    return path;
  }

  if (path === "/") {
    return "/cb";
  } else if (path.endsWith("/")) {
    return path.slice(0, -1);
  } else {
    return path + "/";
  }
}

function getOptions(config) {
  const opts = {
    client_id: config.client_id,
    client_secret: config.client_secret,
    discovery: config.discovery,
    introspection_endpoint: config.introspection_endpoint,
    timeout: config.timeout,
    introspection_endpoint_auth_method:
      config.introspection_endpoint_auth_method,
    bearer_only: config.bearer_only,
    realm: config.realm,
    redirect_uri_path: config.redirect_uri_path || getRedirectUriPath(),
    scope: config.scope,
    response_type: config.response_type,
    ssl_verify: config.ssl_verify,
    token_endpoint_auth_method: config.token_endpoint_auth_method,
    recovery_page_path: config.recovery_page_path,
    filters: parseFilters(config.filters),
    logout_path: config.logout_path,
    redirect_after_logout_uri: config.redirect_after_logout_uri,
  };

  // ISSUER/HOSTNAME SPLIT
  // The browser reaches Keycloak at the issuer host (localhost:8080) but THIS
  // container can't (its localhost is Kong itself). If `internal_host` is set,
  // we build a metadata table with:
  //   • browser-facing endpoints (authorization, end_session) keep the issuer host
  //   • server-facing endpoints (token, userinfo, jwks) use internal_host
  if (config.internal_host && config.internal_host !== "") {
    const issuerBase = config.discovery.replace(
      /\/\.well-known\/openid-configuration$/,
      ""
    );
    const pathMatch = issuerBase.match(/^https?:\/\/[^\/]+(.*?)$/);
    const path = pathMatch ? pathMatch[1] : "";
    const internalBase = "http://" + config.internal_host + path;

    opts.discovery = {
      issuer: issuerBase,
      authorization_endpoint:
        issuerBase + "/protocol/openid-connect/auth",
      end_session_endpoint: issuerBase + "/protocol/openid-connect/logout",
      token_endpoint: internalBase + "/protocol/openid-connect/token",
      token_introspection_endpoint:
        internalBase + "/protocol/openid-connect/token/introspect",
      userinfo_endpoint: internalBase + "/protocol/openid-connect/userinfo",
      jwks_uri: internalBase + "/protocol/openid-connect/certs",
    };
  }

  return opts;
}

function exit(httpStatusCode, message) {
  kong.response.exit(httpStatusCode, message);
}

function injectAccessToken(accessToken) {
  kong.request.set_header("X-Access-Token", accessToken);
}

function injectIDToken(idToken) {
  const tokenStr = JSON.stringify(idToken);
  const encoded = Buffer.from(tokenStr).toString("base64");
  kong.request.set_header("X-ID-Token", encoded);
}

function injectUser(user) {
  const tmpUser = { ...user };
  tmpUser.id = user.sub;
  tmpUser.username = user.preferred_username;
  const userinfo = JSON.stringify(user);
  const encoded = Buffer.from(userinfo).toString("base64");
  kong.request.set_header("X-Userinfo", encoded);
}

function hasBearerAccessToken() {
  const header = kong.request.get_header("authorization");
  if (!header) {
    return false;
  }
  const parts = header.split(" ");
  if (parts.length !== 2) {
    return false;
  }
  return parts[0].toLowerCase() === "bearer";
}

module.exports = {
  getRedirectUriPath,
  getOptions,
  exit,
  injectAccessToken,
  injectIDToken,
  injectUser,
  hasBearerAccessToken,
  parseFilters,
};
