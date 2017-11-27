"use strict";

let local_settings = {};

exports.log_level = "debug";
exports.log_data = false;

exports.ssl_cert = "/etc/ssl/certs/floobits-dev.crt";
exports.ssl_key = "/etc/ssl/private/floobits-dev.key";
exports.ssl_ca = ["/etc/ssl/certs/floobits.com-intermediate.crt"];
exports.ciphers = "ECDHE-RSA-AES256-SHA384:AES256-SHA256:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM";

exports.is_master = true;

// Local ports
exports.http_port = 80;
exports.https_port = 443;
exports.json_port = 3149;
exports.json_port_ssl = 3449;

// Local Auth
exports.auth = {
  username: "django",
  password: "test"
};

exports.django_base_url = "https://dev.fixtheco.de";
exports.django_user = "nodejs";
exports.django_pass = "eng8shahv6eep8Uivo9wuNoob";

exports.colab_master = {
  ip: "dev.fixtheco.de",
  ssl: true,
  port: 3449,
};

// If any of these are true, mark the server as busy.
exports.busy = {
  loadavg: 0.7,
  mem_used: 0.7,
};

// If abs(disk usage - average usage) > 0.1, balance (basically 10% disk usage difference)
exports.rebalance_threshold = 0.1;

exports.slave_error_threshold = 10000;
exports.repcount = 3;

// Rate limit for indentation error messages
exports.indent_error_limit = 60000;
// Rate limit for carriage return error messages
exports.cr_error_limit = 60000;

exports.conn_keepalive = 30000;

// Disconnect unauthed clients after 30 seconds
exports.auth_timeout = 30000;

// Kill repo clone/pull cmds after 2 minutes
exports.repo_timeout = 120000;

// Defaults:
// Patch_DeleteThreshold = 0.5;
// Match_Threshold = 0.5;
// Match_Distance = 1000;
exports.dmp = {
  Patch_DeleteThreshold: 0.375,
  Match_Threshold: 0.375,
  Match_Distance: 100,
};

exports.preload_bufs = false;

exports.replicate_interval = 15000;

exports.request_defaults = {
  sendImmediately: true,
  strictSSL: false,
  headers: {
    "User-Agent": "Colab"
  }
};

exports.solicitation_update_timeout = 30000;
exports.solicitation_keep_alive_timeout = 180000;

exports.max_events = 20;

exports.max_buf_history = 15;
exports.max_buf_len = 10000000; // 10MB

exports.max_req_len = 1000000; // 1MB

exports.save_delay = 120000;

exports.base_dir = "/mnt/floobits";

exports.readme = {
  name: "FLOOBITS_README.md",
  text: "# Welcome to Floobits!\n\nIt looks like you're in an empty workspace. If you're using the web editor, you can \nclick on the menu in the upper left to upload or create files.\n\nIf you're using a native editor, you might want to read our help docs at \nhttps://floobits.com/help/plugins/\n"
};

try {
  local_settings = require("./local_settings.js");
} catch (e) {
  throw new Error("Error loading local settings:" + e.toString());
}

for (let k of Object.keys(local_settings)) {
  exports[k] = local_settings[k];
}
