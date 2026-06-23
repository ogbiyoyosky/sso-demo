/**
 * filter.js - Request filtering logic
 */

function shouldIgnoreRequest(patterns) {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  const uri = kong.request.get_path();
  for (const pattern of patterns) {
    if (uri.includes(pattern)) {
      return true;
    }
  }
  return false;
}

function shouldProcessRequest(config) {
  return !shouldIgnoreRequest(config.filters);
}

module.exports = {
  shouldProcessRequest,
};
