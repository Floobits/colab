var crypto = require('crypto');
var util = require('util');
var events = require('events');

var async = require('async');
var dmp_module = require('diff_match_patch');
var DMP = new dmp_module.diff_match_patch();
var _ = require('underscore');

var db = require('./db');
var log = require('./log');
var s3 = require('./s3');
var settings = require('./settings');
var utils = require('./utils');


var ColabBuffer = function (room, path, id, text, md5, create) {
  var self = this;
  self.guid = util.format("%s-%s", room.id, id);
  self.id = id;
  self.path = path;
  self.room = room;
  self._state = text || "";
  self._md5 = md5 || utils.md5(self._state);

  self._last_state = self._state;
  self._last_md5 = self._md5;
  self.saved_md5 = self._md5;

  self.prev_bufs = [];
  self.highlights = {};
  self.loaded = false;
  self.patch_timeout = null;
  self.save_timeout = null;

  if (create) {
    log.debug("created new buffer", self.guid);
    self.loaded = true;
    self.save(create);
  } else {
    log.debug("loading buffer", self.guid);
  }
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

ColabBuffer.prototype.load = function (cb) {
  var self = this,
      s3_client = s3.get_client(),
      req = s3_client.get(self.guid);
  cb = cb || function () {};

  req.on("response", function (res) {
    var data = "";
    res.on("data", function (chunk) {
      data += chunk;
    });
    res.on("end", function () {
      self._state = data;
      self._md5 = utils.md5(self._state);
      self.loaded = true;
      self.emit("load");
      log.log("loaded buffer", self.guid, self.path);
      cb(null, self);
    });
    res.on("error", cb);
  });
  req.end();
};

ColabBuffer.prototype.save = function (create, cb) {
  var self = this,
      auto,
      skip_save = (create !== true && self.saved_md5 === self._md5);

  if (skip_save) {
    log.debug("Buf", self.guid, "hasn't changed. Not saving to s3 or updating room.");
  }

  auto = {
    db: function(cb){
      if (create) {
        db.client.query("INSERT INTO room_buffer (fid, path, room_id, md5) VALUES ($1, $2, $3, $4)",
          [self.id, self.path, self.room.id, self._md5], cb);
      } else {
        db.client.query("UPDATE room_buffer SET path = $1, md5 = $2 WHERE room_id = $3 AND fid = $4",
          [self.path, self._md5, self.room.id, self.id], cb);
      }
    },
    put: ['db', function(cb) {
      if (skip_save) {
        cb();
        return;
      }
      var s3_client = s3.get_client();
      var req = s3_client.put(self.guid, {
        "Content-Length": Buffer.byteLength(self._state, 'utf8'),
        "Content-Type": "text/plain"
      });

      req.on("response", function (res) {
        if (res.statusCode === 200) {
          return cb();
        }
        log.error("error saving buf", self.guid, "to s3");
        return cb("status code: " + res.statusCode);
      });
      req.end(self._state);
    }]
  };

  async.auto(auto, function(err, result) {
    if (err) {
      log.error("error saving buffer", self.id, self.path, "err:", err);
    } else {
      log.debug("saved buffer", self.id, self.path);
      self.saved_md5 = self._md5;
    }
    if (cb) {
      cb(err, result);
    }
  });

  if (!skip_save) {
    self.room.save();
  }
};

ColabBuffer.prototype.patch = function (agent, patch_text, md5_before, md5_after) {
  var self = this;
  var self_md5_before = self._md5;
  var self_md5_after;
  var patches;
  var result;
  var prev_result;
  var i;
  var clean_patch = true;

  if (md5_after === self._md5) {
    // Only a stupid client would do this
    log.log("Stupid client. md5 already matches", self._md5, "not doing anything. Patch text:", patch_text);
    return;
  }

  log.debug("parsing patch text\"", patch_text, "\"");
  try {
    patches = DMP.patch_fromText(patch_text);
  } catch (e) {
    log.error("Couldn't get patches from text:", e);
    agent.disconnect("Unable to parse the patch you sent.");
    return;
  }
  if (patches.length === 0) {
    log.log("Stupid client. Patch is empty.");
    return;
  }

  if (settings.checksum_patches && md5_before !== self_md5_before) {
    log.debug("md5_before doesn't match. BE WARY!");
    _.each(self.prev_bufs, function (prev_buf) {
      if (prev_buf.md5 === md5_before) {
        log.debug("found matching previous md5. applying patch", patches);
        prev_result = DMP.patch_apply(patches, prev_buf.buf);
      }
    });
    if (prev_result && utils.patched_cleanly(prev_result)) {
      // TODO: patch old version, calculate diff, and send patch
    } else {
      log.error("Patch wasn't applied!", prev_result);
      agent.write("get_buf", self.to_json());
      return;
    }
  }

  log.debug("applying patch", patches, "to buf");
  result = DMP.patch_apply(patches, self._state);
  if (utils.patched_cleanly(result) === false) {
    log.error("Patch wasn't applied!", result);
    agent.write("get_buf", self.to_json());
    return;
  }

  self_md5_after = utils.md5(result[0]);
  if (settings.checksum_patches && self_md5_after !== md5_after) {
    if (self_md5_before === md5_before) {
      log.error("Patch was applied cleanly from same starting position, but we got out of sync? WTF!?");
    }
    log.error("md5 doesn't match! client:", md5_before, "->", md5_after, ". server:", self_md5_before, "->", self_md5_after, ". we should re-request the file but we don't");
    agent.write("get_buf", self.to_json());
    // TODO: this is a bug. we patch the buf but return before sending patches to all clients
    return;
  }

  self.prev_bufs.push(self.to_json());
  if (self.prev_bufs.length > settings.max_buf_history) {
    self.prev_bufs.shift();
  }
  self._state = result[0];
  log.debug("state is now", self._state);
  self._md5 = self_md5_after;

  function send_patch(md5_before, md5_after, patches) {
    self.room.emit("dmp", agent, "patch", {
      user_id: agent.id,
      username: agent.username,
      md5_before: md5_before,
      md5_after: md5_after,
      id: self.id,
      path: self.path,
      patch: DMP.patch_toText(patches)
    });
    self.save_timeout = self.save_timeout || setTimeout(function () {
      self.save();
      self.save_timeout = null;
    }, settings.save_delay);
  }

  if (settings.patch_delay === 0) {
    send_patch(self_md5_before, self_md5_after, patches);
  } else {
    self.patch_timeout = self.patch_timeout || setTimeout(function () {
      var patches;
      if (self._md5 !== self._last_md5) {
        patches = DMP.patch_make(self._last_state, self._state);
        send_patch(self._last_md5, self._md5, patches);
        self._last_state = self._state;
        self._last_md5 = self._md5;
      }
      self.patch_timeout = null;
    }, settings.patch_delay);
  }
};

ColabBuffer.prototype.highlight = function (agent, ranges, ping) {
  var self = this;
  var highlight = {
    id: self.id,
    user_id: agent.id,
    username: agent.username,
    ranges: ranges,
    ping: !!ping
  };
  self.highlights[agent.id] = ranges;
  self.room.last_highlight = highlight;
  self.room.emit('dmp', agent, "highlight", highlight);
};

module.exports = ColabBuffer;
