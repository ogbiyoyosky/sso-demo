/**
 * handler.js - Kong OIDC plugin handler, JavaScript version
 *
 * Ported from the Lua nokia/kong-oidc plugin to Kong 3.x JavaScript PDK.
 * Handles OIDC authentication: introspect bearer tokens, run OIDC code flow,
 * and inject X-Userinfo / X-Access-Token / X-ID-Token headers.
 */

const utils = require("./utils");
const filter = require("./filter");
const session = require("./session");

// Mock lua-resty-openidc module - in real implementation, would call external service
// For now, we'll use Kong's native capabilities
const resty_openidc = require("resty.openidc");

function makeOidc(oidcConfig) {
  kong.log.debug(
    "OidcHandler calling authenticate, requested path: " +
      kong.request.get_path_with_query()
  );
  try {
    const res = resty_openidc.authenticate(oidcConfig);
    if (!res) {
      if (oidcConfig.recovery_page_path) {
        kong.log.debug(
          "Entering recovery page: " + oidcConfig.recovery_page_path
        );
        return kong.response.exit(302, "", {
          Location: oidcConfig.recovery_page_path,
        });
      }
      utils.exit(500, "Authentication failed");
    }
    return res;
  } catch (err) {
    if (oidcConfig.recovery_page_path) {
      kong.log.debug(
        "Entering recovery page: " + oidcConfig.recovery_page_path
      );
      return kong.response.exit(302, "", {
        Location: oidcConfig.recovery_page_path,
      });
    }
    utils.exit(500, err.message || "Authentication error");
  }
}

function introspect(oidcConfig) {
  if (!utils.hasBearerAccessToken() && oidcConfig.bearer_only !== "yes") {
    return null;
  }

  try {
    const res = resty_openidc.introspect(oidcConfig);
    if (!res) {
      if (oidcConfig.bearer_only === "yes") {
        kong.response.set_header(
          "WWW-Authenticate",
          'Bearer realm="' +
            oidcConfig.realm +
            '",error="Introspection failed"'
        );
        utils.exit(401, "Unauthorized");
      }
      return null;
    }
    kong.log.debug(
      "OidcHandler introspect succeeded, requested path: " +
        kong.request.get_path_with_query()
    );
    return res;
  } catch (err) {
    if (oidcConfig.bearer_only === "yes") {
      kong.response.set_header(
        "WWW-Authenticate",
        'Bearer realm="' + oidcConfig.realm + '",error="' + err.message + '"'
      );
      utils.exit(401, err.message || "Unauthorized");
    }
    return null;
  }
}

function handle(oidcConfig) {
  let response = null;

  if (oidcConfig.introspection_endpoint) {
    response = introspect(oidcConfig);
    if (response) {
      utils.injectUser(response);
    }
  }

  if (!response) {
    response = makeOidc(oidcConfig);
    if (response) {
      if (response.user) {
        utils.injectUser(response.user);
      }
      if (response.access_token) {
        utils.injectAccessToken(response.access_token);
      }
      if (response.id_token) {
        utils.injectIDToken(response.id_token);
      }
    }
  }
}

// Kong plugin interface
return {
  PRIORITY: 1000,
  VERSION: "1.2.4-kong3-js",

  access: function (config) {
    const oidcConfig = utils.getOptions(config);

    if (filter.shouldProcessRequest(oidcConfig)) {
      session.configure(config);
      handle(oidcConfig);
    } else {
      kong.log.debug(
        "OidcHandler ignoring request, path: " + kong.request.get_path()
      );
    }
  },
};
