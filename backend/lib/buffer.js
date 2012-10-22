var crypto = require('crypto');
var util = require('util');
var events = require('events');

var DMP = new require('diff_match_patch').diff_match_patch();
var _ = require('underscore');

var ColabBuffer = function(agent, path, patch){
  var self = this;
  self.guid = util.format("%s-%s", agent.id, path);
  self.path = path;
  self._agent = agent;
  self._state = "";
  self._checksum = null;
  self._is_valid = true;
};

util.inherits(ColabBuffer, events.EventEmitter);

ColabBuffer.prototype.on_dmp = function(patch, checksum){
  var expected_checksum;
  var hash;
  if (!self._is_valid){
    log.error("buffer is no longer valid because we got out of sync earlier. FROWNY FACE :(");
    return;
  }
  if (checksum === self._checksum){
    return;
  }
  // probably should adjust some nobs or something?
  DMP.patch_apply(patch, self._state);
  hash = crypto.createHash('md5').update(self._state);

  expected_checksum = hash.digest("hex");
  if (expected_checksum !== checksum){
    // TODO- tell client to resend whole damn file
    self._is_valid = false;
    log.error("checksum doesn't match! expected", expected_checksum, "but got", checksum, ". we should re-request the file but we don't");
    return;
  }
  self.checksum = checksum;

  // tell our agent
  self._agent.emit('dmp', {
    checksum: self.checksum,
    guid: self.guid,
    path: self.path,
    patch: patch
  });
};

module.exports = ColabBuffer;
