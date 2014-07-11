/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var _ = require("lodash");

var local_settings = {};

exports.ssl_cert = "/etc/ssl/certs/floobits-dev.crt";
exports.ssl_key = "/etc/ssl/private/floobits-dev.key";
exports.ssl_ca = ["/etc/ssl/certs/startssl-sub.class1.server.ca.pem"];
exports.ciphers = "ECDHE-RSA-AES256-SHA384:AES256-SHA256:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM";

exports.log_level = "debug";

exports.conn_keepalive = 30000;

exports.json_port = 3149;
exports.json_port_ssl = 3449;

exports.db_info = {
  user: "floobits",
  password: "1234",
  database: "floobits",
  host: "127.0.0.1"
};

exports.django_base_url = "https://dev.fixtheco.de";
exports.django_user = "nodejs";
exports.django_pass = "test";

exports.api_port = 8444;
exports.api_auth = {
  username: "django",
  password: "test"
};

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
