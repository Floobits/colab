var crypto = require('crypto');
var util = require('util');

exports.db_perms_mapping = {
  "view_room": ["get_buf"],
  "edit_room": ["patch", "get_buf", "create_buf", "highlight", "msg", "delete_buf", "rename_buf"],
  "admin_room": ["kick"]
};

exports.md5 = function (text) {
  var hash = crypto.createHash("md5").update(unescape(encodeURIComponent(text)));
  return hash.digest("hex");
};

exports.patched_cleanly = function (result) {
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
