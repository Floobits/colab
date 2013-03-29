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
  var i,
      clean_patch = true;
  for (i = 0; i < result[1].length; i++) {
    if (result[1][i] !== true) {
      clean_patch = false;
      break;
    }
  }
  return clean_patch;
};

walk_dir = function (p) {
  // TODO: make this use async methods
  var filenames,
      paths = [],
      st = fs.lstatSync(p);

  // Ignore hidden files. Yeah I know this is lame and you can put hidden files in a repo/room.
  if (path.basename(p)[0] === ".") {
    return paths;
  }
  if (st.isDirectory()) {
    filenames = fs.readdirSync(p);
    _.each(filenames, function (file) {
      var abs_path = path.join(p, file);
      paths = paths.concat(walk_dir(abs_path));
    });
  } else {
    paths.push(p);
  }
  return paths;
};

module.exports = {
  db_perms_mapping: db_perms_mapping,
  md5: md5,
  patched_cleanly: patched_cleanly,
  walk_dir: walk_dir
};
