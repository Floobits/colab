/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var fs = require("fs");
var path = require("path");
var util = require("util");

var _ = require("lodash");

/*eslint-disable no-sync */
function create_local_settings(old_dir) {
  var old_settings,
    new_settings,
    local_settings;

  if (fs.existsSync(path.join(old_dir, "local_settings.js"))) {
    console.log("local_settings already exists. No need to migrate.");
    return;
  }

  old_settings = require(path.join(old_dir, "settings.js"));
  // Create an empty file so settings.js doesn't explode
  fs.writeFileSync(path.join(__dirname, "local_settings.js"), "");
  new_settings = require("./settings.js");
  local_settings = {};

  _.each(old_settings, function (v, k) {
    if (_.isEqual(v, new_settings[k])) {
      return;
    }
    console.log("Migrating", k);
    local_settings[k] = v;
  });

  local_settings = util.format("module.exports = %s;", JSON.stringify(local_settings, null, "  "));
  fs.writeFileSync(path.join(old_dir, "local_settings.js"), local_settings);
}

function add_colab_slave_settings(settings_dir) {
  var local_settings,
    controller_settings,
    settings_to_delete,
    settings_to_migrate;

  settings_to_migrate = [
    "http_port",
    "https_port",
    "repcount",
  ];

  settings_to_delete = [
    "cache_servers",
    "conn_keepalive",
    "conn_timeout",
    "db_info",
    "max_buf_history",
    "max_buf_len",
    "readme",
    "save_delay",
  ];

  local_settings = require(path.join(settings_dir, "local_settings.js"));

  if (_.every(settings_to_migrate, function (s) {
    return !_.isUndefined(local_settings[s]);
  })) {
    console.log("Settings already migrated. Skipping.");
    return;
  }

  try {
    controller_settings = require("/data/colabcontrol/lib/settings.js");
  } catch (e) {
    console.error("Unable to load controller settings:", e);
    console.log("Skipping colab settings migration.");
    return;
  }

  _.each(settings_to_migrate, function (k) {
    if (_.isUndefined(local_settings[k])) {
      console.log("Migrating", k, "from controller settings");
      local_settings[k] = controller_settings[k];
    }
  });

  _.each(settings_to_delete, function (k) {
    console.log("Deleting", k, "from colab settings");
    delete local_settings[k];
  });

  local_settings.auth = local_settings.api_auth;
  delete local_settings.api_auth;

  // prod instances die if repcount < 3
  if (local_settings.repcount < 3) {
    local_settings.log_level = "debug";
  }

  local_settings = util.format("module.exports = %s;", JSON.stringify(local_settings, null, "  "));
  fs.writeFileSync(path.join(settings_dir, "local_settings.js"), local_settings);
}
/*eslint-enable no-sync */

let colab_path = "/data/colab/lib";

if (process.argv.length === 3) {
  colab_path = process.argv[2];
} else if (process.argv.length > 3) {
  throw new Error(util.format("Usage: node %s [path]", process.argv[1]));
}

create_local_settings(colab_path);

add_colab_slave_settings(colab_path);
