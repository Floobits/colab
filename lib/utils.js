var crypto = require('crypto');
var util = require('util');

exports.md5 = function (text) {
  var hash = crypto.createHash("md5").update(text);
  return hash.digest("hex");
};
