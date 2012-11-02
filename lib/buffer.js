var crypto = require('crypto');
var util = require('util');
var events = require('events');

var dmp_module = require('diff_match_patch');
var DMP = new dmp_module.diff_match_patch();
var _ = require('underscore');

var log = require('./log');
var utils = require('./utils');


var ColabBuffer = function (room, path, id, text) {
  var self = this;
  self.guid = util.format("%s-%s", room.id, id);
  self.id = id;
  self.path = path;
  self.room = room;
  self._state = text || "";
  self._md5 = utils.md5(self._state);
  log.debug("created new buffer", self.guid);
};

util.inherits(ColabBuffer, events.EventEmitter);

ColabBuffer.prototype.to_json = function () {
  var self = this;
  return {
    "path": self.path,
    "buf": self._state,
    "id": self.id,
    "md5": self._md5
  };
};

ColabBuffer.prototype.patch = function (client, patch_text, md5) {
  var self = this;
  var expected_md5;
  var hash;
  var patches;
  var result;

  if (md5 === self._md5) {
    log.debug("md5 is the same as previous", md5, "not doing anything");
    return;
  }
  log.debug("parsing patch text\"", patch_text, "\"");
  patches = DMP.patch_fromText(patch_text);
  if (patches.length === 0) {
    log.debug("patch is empty");
    return;
  }
  log.debug("applying patch", patches, "to buf");
  result = DMP.patch_apply(patches, self._state);
  if (result[1][0] === true) {
    expected_md5 = utils.md5(result[0]);
    if (expected_md5 === md5) {
      self._state = result[0];
      log.debug("state is now", self._state);
      self.md5 = md5;
    } else {
      log.error("md5 doesn't match! expected", expected_md5, "but got", md5, ". we should re-request the file but we don't");
      client.write("get_buf", self.to_json());
      return;
    }
  } else {
    log.error("Patch wasn't applied!", result);
    client.write("get_buf", self.to_json());
    return;
  }

  self.room.emit('dmp', client, {
    md5: self.md5,
    id: self.id,
    path: self.path,
    patch: DMP.patch_toText(patches)
  });
};

module.exports = ColabBuffer;
