/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var _ = require("lodash");

var local_settings = {};

exports.ssl_cert = "/etc/ssl/certs/floobits-dev.crt";
exports.ssl_key = "/etc/ssl/private/floobits-dev.key";
exports.ssl_ca = ["/etc/ssl/certs/startssl-sub.class1.server.ca.pem"];
exports.ciphers = "ECDHE-RSA-AES256-SHA384:AES256-SHA256:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM";

exports.log_level = "debug";

exports.http_port = 80;
exports.https_port = 443;

exports.request_defaults = {
  sendImmediately: true,
  strictSSL: false,
  headers: {
    "User-Agent": "ColabControl"
  }
};

exports.db_info = {
  user: "floobits",
  password: "1234",
  database: "floobits",
  host: "127.0.0.1"
};

exports.cache_servers = ["127.0.0.1:11211"];

// If any of these are true, mark the server as busy.
exports.busy = {
  loadavg: 0.5,
  mem_free: 0.3,
  rss_used: 0.7
};

// If abs(disk usage - average usage) > 0.1, balance (basically 10% disk usage difference)
exports.rebalance_threshold = 0.1;

exports.auth = {
  username: "django",
  password: "test"
};

exports.colab_servers = [
  {
    ip: "dev.fixtheco.de",
    external_ip: "dev.fixtheco.de",
    api_port: 8444,
    colab_port: 3449,
    ssl: true,
    name: "debug",
    exclude: false
  }
];

exports.poll_interval = 10000;
exports.colab_error_threshold = 3;
exports.repcount = 3;

try {
  local_settings = require("./local_settings.js");
} catch (e) {
  console.error("Error loading local settings:", e);
  process.exit(1);
}

_.each(local_settings, function (v, k) {
  exports[k] = v;
});
