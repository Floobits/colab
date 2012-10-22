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
  self._checksum = null;
  self._is_valid = true;
  log.debug("created new buffer", self.guid);
  self.on('dmp', self.on_dmp.bind(self));
};

util.inherits(ColabBuffer, events.EventEmitter);

ColabBuffer.prototype.on_dmp = function(patch, checksum) {
  var self = this;
  var expected_checksum;
  var hash;
  if (!self._is_valid) {
    log.error("buffer is no longer valid because we got out of sync earlier. FROWNY FACE :(");
    return;
  }
  if (checksum === self._checksum) {
    log.debug("checksum is the same as previous", checksum, "not doing anything");
    return;
  }
  log.debug("applying patch", patch, "to buf");
  // probably should adjust some nobs or something?
  debugger;
  DMP.patch_apply(patch, self._state);
  hash = crypto.createHash('md5').update(self._state);

  expected_checksum = hash.digest("hex");
  if (expected_checksum !== checksum) {
    // TODO- tell client to resend whole damn file
    self._is_valid = false;
    log.error("checksum doesn't match! expected", expected_checksum, "but got", checksum, ". we should re-request the file but we don't");
    return;
  }
  self.checksum = checksum;

  self.room.emit('dmp', {
    checksum: self.checksum,
    guid: self.guid,
    path: self.path,
    patch: patch
  });
};

module.exports = ColabBuffer;
