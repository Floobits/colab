var crypto = require('crypto');
var util = require('util');
var events = require('events');

var DMP = new require('diff_match_patch').diff_match_patch();
var _ = require('underscore');

var ColabBuffer = function(agent, uid, name, patches){
  var self = this;
  self.guid = util.format("%s-%s", agent.id, uid);
  self.name = name;
  self._agent = agent;
  self._state = "";
  self._checksum = null;
  self._is_valid = true;
};

util.inherits(ColabBuffer, events.EventEmitter);

ColabBuffer.prototype.on_dmp = function(patches, checksum){
  if (!self._is_valid){
    return;
  }
  if (checksum === self._checksum){
    return;
  }
  // probably should adjust some nobs or something?
  DMP.patch_apply(patches, self._state);
  var hash = crypto.createHash('md5').update(self._state);

  if (hash.digest("hex") !== checksum){
    // TODO- tell client to resend whole damn file
    self._is_valid = false;
    return;
  }
  self.checksum = checksum;

  // tell our agent
  self._agent.emit('dmp', {
    checksum: self.checksum,
    id: self.guid,
    name: self.name,
    dmp: patches
  });
};

module.exports = ColabBuffer;