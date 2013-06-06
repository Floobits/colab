/*global unescape: true */
var async = require("async");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var util = require("util");

var _ = require("underscore");

var log = require("./log");


var db_perms_mapping = {
  "view_room": ["get_buf"],
  "edit_room": ["patch", "get_buf", "create_buf", "delete_buf", "rename_buf",
                "set_temp_data", "delete_temp_data",
                "highlight", "msg",
                "create_term", "delete_term", "update_term", "term_stdout"],
  "admin_room": ["kick", "pull_repo", "term_stdin"]
};

var mkdirSync = function (path) {
  try{
    /*jslint stupid: true */
    fs.mkdirSync(path);
    /*jslint stupid: false */
  } catch(e){
    if (e.errno && e.errno === 47){
      return;
    }
    throw(e);
  }
};

var md5 = function (text) {
  // TODO: this is atrocious
  var hash = crypto.createHash("md5").update(unescape(encodeURIComponent(text)));
  return hash.digest("hex");
};

var patched_cleanly = function (result) {
  var clean_patch = true,
      i;
  for (i = 0; i < result[1].length; i++) {
    if (result[1][i] !== true) {
      clean_patch = false;
      break;
    }
  }
  return clean_patch;
};

var squelch = function(cb) {
  return function (err, res) {
    if (err) {
      log.debug(err);
    }
    return cb(null, res);
  };
};

var walk_dir = function (p, cb) {
  var paths = [];

  fs.lstat(p, function (err, st) {
    // Ignore hidden files. Yeah I know this is lame and you can put hidden files in a repo/room.
    if (path.basename(p)[0] === ".") {
      return cb(null, paths);
    }
    if (!st.isDirectory()) {
      paths.push(p);
      return cb(null, paths);
    }
    return fs.readdir(p, function (err, filenames) {
      async.each(filenames, function (file, callback) {
        var abs_path = path.join(p, file);
        walk_dir(abs_path, function (err, sub_paths) {
          paths = paths.concat(sub_paths);
          callback(err);
        });
      },
      function (err, result) {
        cb(err, paths);
      });
    });
  });
};

module.exports = {
  db_perms_mapping: db_perms_mapping,
  md5: md5,
  mkdirSync: mkdirSync,
  patched_cleanly: patched_cleanly,
  squelch: squelch,
  walk_dir: walk_dir
};
