var crypto = require('crypto');
var util = require('util');
var events = require('events');

var dmp_module = require('diff_match_patch');
var DMP = new dmp_module.diff_match_patch();
var _ = require('underscore');

var log = require('./log');

var ColabBuffer = function(room, path) {
  var self = this;
  // TODO: this guid could have conflicts
  self.guid = util.format("%s-%s", room.name, path);
  self.path = path;
  self.room = room;
  self._state = "";
  self._md5 = null;
  self._is_valid = true;
  log.debug("created new buffer", self.guid);
  self.on('dmp', self.on_dmp.bind(self));
};

util.inherits(ColabBuffer, events.EventEmitter);

ColabBuffer.prototype.on_dmp = function(patch_text, md5) {
  var self = this;
  var expected_md5;
  var hash;
  var patches;
  var result;
  if (!self._is_valid) {
    log.error("buffer is no longer valid because we got out of sync earlier. FROWNY FACE :(");
    return;
  }
  if (md5 === self._md5) {
    log.debug("md5 is the same as previous", md5, "not doing anything");
    return;
  }
  log.debug("parsing patch text", patch_text);
  patches = DMP.patch_fromText(patch_text);
  log.debug("applying patch", patches, "to buf");
  result = DMP.patch_apply(patches, self._state);
  if (result[1][0] === true) {
    self._state = result[0];
  } else {
    log.error("Patch wasn't applied!", result);
    return;
  }
  hash = crypto.createHash("md5").update(self._state);

  expected_md5 = hash.digest("hex");
  log.debug("state is now", self._state);
  if (expected_md5 !== md5) {
    // TODO- tell client to resend whole damn file
    self._is_valid = false;
    log.error("md5 doesn't match! expected", expected_md5, "but got", md5, ". we should re-request the file but we don't");
    return;
  }
  self.md5 = md5;

  self.room.emit('dmp', {
    md5: self.md5,
    guid: self.guid,
    path: self.path,
    patch: DMP.patch_toText(patches)
  });
};

module.exports = ColabBuffer;
