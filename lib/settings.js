/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var _ = require("lodash");

var local_settings = {};

exports.log_level = "debug";
exports.log_data = false;

exports.ssl_cert = "/etc/ssl/certs/floobits-dev.crt";
exports.ssl_key = "/etc/ssl/private/floobits-dev.key";
exports.ssl_ca = ["/etc/ssl/certs/startssl-sub.class2.server.sha2.ca.pem"];
exports.ciphers = "ECDHE-RSA-AES256-SHA384:AES256-SHA256:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM";

exports.is_master = true;

// Local ports
exports.http_port = 80;
exports.https_port = 443;
exports.json_port = 3149;
exports.json_port_ssl = 3449;
exports.api_port = 8444;

// Local Auth
exports.auth = {
  username: "django",
  password: "test"
};


// Remote hosts and auth
exports.db_info = {
  user: "floobits",
  password: "1234",
  database: "floobits",
  host: "127.0.0.1"
};

exports.django_base_url = "https://dev.fixtheco.de";
exports.django_user = "nodejs";
exports.django_pass = "test";

exports.cache_servers = ["127.0.0.1:11211"];

exports.colab_master = {
  ip: "dev.fixtheco.de",
  ssl: true,
  port: 3449,
};


// If any of these are true, mark the server as busy.
exports.busy = {
  loadavg: 0.5,
  mem_free: 0.3,
  rss_used: 0.7
};

// If abs(disk usage - average usage) > 0.1, balance (basically 10% disk usage difference)
exports.rebalance_threshold = 0.1;

exports.poll_interval = 10000;
exports.colab_error_threshold = 3;
exports.repcount = 3;

exports.conn_keepalive = 30000;

// Defaults:
// Patch_DeleteThreshold = 0.5;
// Match_Threshold = 0.5;
// Match_Distance = 1000;
exports.dmp = {
  Patch_DeleteThreshold: 0.375,
  Match_Threshold: 0.375,
  Match_Distance: 100,
};

exports.request_defaults = {
  sendImmediately: true,
  strictSSL: false,
  headers: {
    "User-Agent": "Colab"
  }
};

exports.solicitation_update_timeout = 60000;

exports.max_events = 20;

exports.max_buf_history = 15;
exports.max_buf_len = 10000000; // 10MB

exports.save_delay = 120000;

exports.base_dir = "/mnt/floobits";
exports.s3 = {};

exports.readme = {
  name: "FLOOBITS_README.md",
  text: "# Welcome to Floobits!\n\nIt looks like you're in an empty workspace. If you're using the web editor, you can \nclick on the menu in the upper left to upload or create files.\n\nIf you're using a native editor, you might want to read our help docs at \nhttps://floobits.com/help/plugins/\n"
};

try {
  local_settings = require("./local_settings.js");
} catch (e) {
  console.error("Error loading local settings:", e);
  process.exit(1);
}

_.each(local_settings, function (v, k) {
  exports[k] = v;
});
