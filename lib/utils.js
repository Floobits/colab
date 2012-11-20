var crypto = require('crypto');
var util = require('util');

exports.md5 = function (text) {
  var hash = crypto.createHash("md5").update(text);
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
