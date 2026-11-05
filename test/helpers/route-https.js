// Preloaded into the CLI under test (via NODE_OPTIONS=--require). Sends every https request
// to the local mock server instead, tagging it with the original host so the mock can tell
// uploads.linear.app from a storage host a download was redirected to.
const http = require('http');
const https = require('https');

const port = process.env.MOCK_PORT;
https.request = function (url, opts, cb) {
  const u = new URL(url);
  const headers = { ...(opts.headers || {}), 'x-orig-host': u.hostname };
  return http.request({ host: '127.0.0.1', port, path: '/__https' + u.pathname + u.search, method: opts.method || 'GET', headers }, cb);
};
