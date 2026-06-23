/**
 * session.js - Session configuration
 */

const utils = require("./utils");

function configure(config) {
  if (config.session_secret) {
    const decodedSecret = Buffer.from(
      config.session_secret,
      "base64"
    ).toString("utf8");
    if (!decodedSecret) {
      utils.exit(
        500,
        "invalid OIDC plugin configuration, session secret could not be decoded"
      );
    }
    // In JavaScript plugin, session is handled by Kong's session library
    // Set the secret in kong.ctx.shared for session use
    kong.ctx.shared.session_secret = decodedSecret;
  }
}

module.exports = {
  configure,
};
