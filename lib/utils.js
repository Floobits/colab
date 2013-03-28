var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var util = require("util");

var _ = require("underscore");


db_perms_mapping = {
  "view_room": ["get_buf"],
  "edit_room": ["patch", "get_buf", "create_buf", "highlight", "msg", "delete_buf", "rename_buf"],
  "admin_room": ["kick"]
};

md5 = function (text) {
  var hash = crypto.createHash("md5").update(unescape(encodeURIComponent(text)));
  return hash.digest("hex");
};

patched_cleanly = function (result) {
  var i;
  var clean_patch = true;
  for (i = 0; i < result[1].length; i++) {
    if (result[1][i] !== true) {
      clean_patch = false;
      break;
    }
  }
  return clean_patch;
};

walk_dir = function (path) {
  var filenames,
      paths = [],
      st = fs.lstatSync(path);

  if (st.isDirectory()) {
    filenames = fs.readDirSync(path);
    _.each(filenames, function (file) {
      var abs_path = path.join(path, file);
      path_list = path_list.concat(walk_dir(abs_path));
    });
  } else {
    path_list.push(path);
  }
  return paths;
};

module.exports = {
  db_perms_mapping: db_perms_mapping,
  md5: md5,
  patched_cleanly: patched_cleanly,
  walk_dir: walk_dir
};
