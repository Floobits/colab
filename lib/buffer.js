var crypto = require('crypto');
var util = require('util');
var events = require('events');

var dmp_module = require('diff_match_patch');
var DMP = new dmp_module.diff_match_patch();
var _ = require('underscore');

var db = require('./db');
var log = require('./log');
var utils = require('./utils');


var ColabBuffer = function (room, path, id, text, create) {
  var self = this;
  self.guid = util.format("%s-%s", room.id, id);
  self.id = id;
  self.path = path;
  self.room = room;
  self._state = text || "";
  self._md5 = utils.md5(self._state);
  self.prev_bufs = [];
  log.debug("created new buffer", self.guid);
  self.save(create);
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

ColabBuffer.prototype.save = function (create) {
  var self = this;
  function query_cb(err, result) {
    log.debug(result);
    if (err) {
      log.error(err);
    }
  }
  if (create) {
    // 5th param is patches
    db.client.query("INSERT INTO room_buffer (fid, path, room_id, cur_state, patches) VALUES ($1, $2, $3, $4, $5)", 
      [self.id, self.path, self.room.id, self._state, ""],
      query_cb
    );
  } else {
    db.client.query("UPDATE room_buffer SET fid = $1, path = $2, cur_state = $3 WHERE room_id = $4 AND fid = $5", [self.id, self.path, self._state, self.room.id, self.id], query_cb);
  }
};

ColabBuffer.prototype.patch = function (client, patch_text, md5_before, md5_after) {
  var self = this;
  var self_md5_before = self._md5;
  var self_md5_after;
  var patches;
  var result;
  var i;
  var ok_to_patch = false;
  var clean_patch = true;

  if (md5_after === self._md5) {
    // Only a stupid client would do this
    log.debug("Stupid client. md5 already matches", self._md5, "not doing anything");
    return;
  }

  log.debug("parsing patch text\"", patch_text, "\"");
  patches = DMP.patch_fromText(patch_text);
  if (patches.length === 0) {
    log.debug("patch is empty");
    return;
  }

  if (md5_before !== self_md5_before) {
    // TODO: store previous versions of buffer and apply the patch to the old one
    log.debug("md5_before doesn't match. BE WARY!");
  }

  log.debug("applying patch", patches, "to buf");
  result = DMP.patch_apply(patches, self._state);
  for (i = 0; i < result[1].length; i++) {
    if (result[1][i] !== true) {
      clean_patch = false;
      break;
    }
  }
  if (clean_patch === false) {
    log.error("Patch wasn't applied!", result);
    client.write("get_buf", self.to_json());
    return;
  }

  self_md5_after = utils.md5(result[0]);
  if (self_md5_after !== md5_after) {
    if (self_md5_before === md5_before) {
      log.error("Patch was applied cleanly from same starting position, but we got out of sync? WTF!?");
    }
    log.error("md5 doesn't match! client:", md5_before, "->", md5_after, ". server:", self_md5_before, "->", self_md5_after, ". we should re-request the file but we don't");
    client.write("get_buf", self.to_json());
    return;
  }

  self.prev_bufs.push(self.to_json());
  if (self.prev_bufs.length > settings.max_buf_history) {
    self.prev_bufs.shift();
  }
  self._state = result[0];
  log.debug("state is now", self._state);
  self._md5 = self_md5_after;
  self.save();

  self.room.emit("dmp", client, "patch", {
    username: client.username,
    md5_before: self_md5_before,
    md5_after: self_md5_after,
    id: self.id,
    path: self.path,
    patch: DMP.patch_toText(patches)
  });
};

module.exports = ColabBuffer;
