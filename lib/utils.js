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
                "create_term", "delete_term", "update_term", "term_stdout", "saved"],
  "admin_room": ["kick", "pull_repo", "term_stdin"]
  // TODO: admin_room should be able to modify other people's perms
};

var mkdirSync = function (path) {
  try {
    /*jslint stupid: true */
    fs.mkdirSync(path);
    /*jslint stupid: false */
  } catch (e) {
    if (e.errno && e.errno === 47) {
      return;
    }
    throw (e);
  }
};

var md5 = function (text) {
  return crypto.createHash("md5").update(text).digest("hex");
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

var squelch = function (cb) {
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
      async.each(filenames,
        function (file, callback) {
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

var is_binary = function (bytes, size) {
  var i,
    max_bytes = 512,
    suspicious_bytes = 0,
    total_bytes;

  if (size === 0) {
    return false;
  }

  total_bytes = Math.min(size, max_bytes);

  if (size >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    // UTF-8 BOM. This isn't binary.
    return false;
  }
  /*jslint continue: true */
  for (i = 0; i < total_bytes; i++) {
    if (bytes[i] === 0) { // NULL byte--it's binary!
      return true;
    }
    if ((bytes[i] < 7 || bytes[i] > 14) && (bytes[i] < 32 || bytes[i] > 127)) {
      // UTF-8 detection
      if (bytes[i] > 191 && bytes[i] < 224 && i + 1 < total_bytes) {
        i++;
        if (bytes[i] < 192) {
          continue;
        }
      } else if (bytes[i] > 223 && bytes[i] < 239 && i + 2 < total_bytes) {
        i++;
        if (bytes[i] < 192 && bytes[i + 1] < 192) {
          i++;
          continue;
        }
      }
      suspicious_bytes++;
      // Read at least 32 bytes before making a decision
      if (i > 32 && (suspicious_bytes * 100) / total_bytes > 10) {
        return true;
      }
    }
  }
  /*jslint continue: false */
  if ((suspicious_bytes * 100) / total_bytes > 10) {
    return true;
  }

  return false;
};

module.exports = {
  db_perms_mapping: db_perms_mapping,
  is_binary: is_binary,
  md5: md5,
  mkdirSync: mkdirSync,
  patched_cleanly: patched_cleanly,
  squelch: squelch,
  walk_dir: walk_dir
};
