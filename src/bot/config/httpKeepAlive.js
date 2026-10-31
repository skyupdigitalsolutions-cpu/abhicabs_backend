const http = require('http');
const https = require('https');
const axios = require('axios');

/**
 * Reuse connections to MSG91 and Google. On Node 18 every request opens a NEW connection and repeats the secure
 * handshake (several trips back and forth) before it sends anything. With keep-alive the connection stays open
 * between messages, so each call to MSG91 or Google starts sending straight away.
 * Must be loaded before the modules that create their own axios clients (see server.js).
 */
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 20 });
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 20 });

if (axios.defaults) {
  axios.defaults.httpsAgent = httpsAgent;
  axios.defaults.httpAgent = httpAgent;
}

module.exports = { httpsAgent, httpAgent };
