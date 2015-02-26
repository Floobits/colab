/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var fs = require("fs");
var path = require("path");
var util = require("util");

var _ = require("lodash");

/*eslint-disable no-sync */
function migrate_settings() {
  var old_dir,
    old_settings,
    new_settings,
    local_settings;

  if (process.argv.length === 2) {
    old_dir = "/data/colab/lib";
  } else if (process.argv.length === 3) {
    old_dir = process.argv[2];
  } else {
    throw new Error(util.format("Usage: node %s [path]", process.argv[1]));
  }

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
    if (v !== new_settings[k]) {
      console.log("Migrating", k);
      local_settings[k] = v;
    }
  });

  local_settings = util.format("module.exports = %s;", JSON.stringify(local_settings, null, "  "));
  fs.writeFileSync(path.join(old_dir, "local_settings.js"), local_settings);
}
/*eslint-enable no-sync */

migrate_settings();
