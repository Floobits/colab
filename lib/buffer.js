var events = require("events");
var fs = require("fs");
var path = require("path");
var util = require("util");

var async = require("async");
var log = require("floorine");
var DMP = require("native-diff-match-patch");
var diff_match_patch = require('diff_match_patch');
var JS_DMP = new diff_match_patch.diff_match_patch();
var _ = require("lodash");

var db = require("./db");
var settings = require("./settings");
var utils = require("./utils");

var SUPPORTED_ENCODINGS, BaseBuffer, BinaryBuffer, TextBuffer, make_buffer;

// Defaults:
// Patch_DeleteThreshold = 0.5;
// Match_Threshold = 0.5;
// Match_Distance = 1000;

JS_DMP.Patch_DeleteThreshold = 0.25;
JS_DMP.Match_Threshold = 0.25;
JS_DMP.Match_Distance = 100;

DMP.set_Patch_DeleteThreshold(0.25);
DMP.set_Match_Threshold(0.25);
DMP.set_Match_Distance(100);


BaseBuffer = function (room, id, path, state, md5, create) {
  var self = this;
  self.id = id;
  self.path = path;
  self.room = room;
  self._state = state;
  self._md5 = md5 || utils.md5(self._state);

  self._last_state = self._state;
  self._last_md5 = self._md5;
  self.saved_md5 = self._md5;

  self.prev_bufs = [];
  self.highlights = {};
  self.loaded = false;
  self.save_timeout = null;
  self.get_buf_timeouts = {};

  self.db_key = util.format("buf_%s", self.id);
  self.content_key = util.format("buf_content_%s", self.id);

  if (create) {
    log.debug("created new buffer", self.toString());
    self.loaded = true;
    self.save(create, function (err) {
      if (err) {
        // TODO: bubble this up to someone who can deal with it
        log.error("ERROR SAVING BUFFER AFTER CREATION:", err);
      }
    });
  }
};

util.inherits(BaseBuffer, events.EventEmitter);

BaseBuffer.prototype.toString = function () {
  var self = this;
  return util.format("Buffer %s %s/%s md5 %s length %s", self.id, self.room, self.path, self._md5, self._state.length);
};

BaseBuffer.prototype.get_db_encoding = function () {
  var self = this;
  return self.encoding === "utf8" ? "utf8" : "binary";
};

BaseBuffer.prototype.to_room_info = function () {
  var self = this;
  return {
    "path": self.path,
    "id": self.id,
    "md5": self._md5,
    "encoding": self.encoding
  };
};

BaseBuffer.prototype.to_json = function (agent) {
  var self = this,
    encoding = self.encoding;

  if (agent && !_.contains(agent.supported_encodings, self.encoding)) {
    encoding = "utf8";
  }

  return _.extend(self.to_room_info(), {buf: self._state.toString(encoding)});
};

BaseBuffer.prototype.to_prev_buf = function () {
  var self = this;
  return _.extend(self.to_room_info(), {buf: self._state});
};

BaseBuffer.prototype.load = function (cb) {
  var self = this,
    buf_md5;

  self.room.db.get(self.content_key, { valueEncoding: "binary" }, function (err, result) {
    if (!err) {
      self._state = result;
    } else if (err.type === "NotFoundError") {
      log.debug("Buffer %s content not found. Setting to empty.", self.toString());
      self._state = new Buffer(0);
    } else {
      self.emit("load_error");
      return cb(err, result);
    }

    buf_md5 = utils.md5(self._state);
    if (self._md5 !== buf_md5) {
      log.warn("MD5 mismatch when loading %s! Was %s. Should be %s", self.toString(), buf_md5, self._md5);
      self._md5 = buf_md5;
    }
    self.loaded = true;
    self.emit("load");
    return cb(null, self);
  });
};

BaseBuffer.prototype.save = function (create, cb) {
  var self = this,
    actions = [],
    batch,
    saved_md5 = self._md5,
    skip_save = (create !== true && self.saved_md5 === self._md5);

  if (skip_save) {
    log.debug("Skipping save for %s", self.toString());
    return cb(null, self);
  }

  self.room.dirty = true;

  if (!self.room.db) {
    // TODO: so lame. Figure out where we're not cancelling the timeout.
    return cb(util.format("No db for %s", self.toString()), self);
  }
  try {
    batch = self.room.db.batch();
  } catch (e) {
    return cb(util.format("Error creating db.batch: %s", e));
  }
  batch.put(self.db_key, {
    id: self.id,
    path: self.path,
    deleted: false,
    md5: self._md5,
    encoding: self.encoding
  }, {
    valueEncoding: "json"
  });

  if (self._state.length > 0) {
    batch.put(self.content_key, self._state, { valueEncoding: "binary" });
  } else {
    actions.push(function (cb) {
      self.room.db.del(self.content_key, function (err) {
        if (err && err.type === "NotFoundError") {
          err = null;
        }
        return cb(err);
      });
    });
  }
  actions.push(batch.write.bind(batch));

  async.parallel(actions, function (err) {
    if (!err) {
      self.saved_md5 = saved_md5;
    }
    return cb(err);
  });
};

BaseBuffer.prototype.set = function (agent, state, md5, encoding, cb) {
  var self = this,
    patches,
    self_md5_before = self._md5;

  cb = cb || function () { return; };

  if (self.encoding !== encoding) {
    return self.room.delete_buf(self.id, agent, true, function (err) {
      if (err) {
        return cb(err);
      }
      self.room.create_buf(self.path, state, encoding, agent, function (err, result) {
        log.debug("Reset buffer ", self.id, self.path);
        return cb(err, result);
      });
    });
  }

  if (!SUPPORTED_ENCODINGS[encoding]) {
    return cb("Unsupported encoding: ", encoding);
  }
  if (encoding === "utf8") {
    if (!_.isString(state)) {
      state = state.toString(encoding);
    }
    state = state.replace("\r\n", "\n");
  }
  state = new Buffer(state, encoding);
  patches = DMP.patch_make(self._state, state);
  self._state = state;
  self._md5 = utils.md5(self._state);
  if (md5 && self._md5 !== md5) {
    log.error(util.format("%s client md5 sum doesn't match: %s", self.toString(), md5));
  }

  self.cancel_get_buf(agent);

  log.debug("Set buffer", self.id, self.path);
  self.room.emit("dmp", agent, "patch", {
    user_id: agent.id,
    username: agent.username,
    md5_before: self_md5_before,
    md5_after: self._md5,
    id: self.id,
    path: self.path,
    patch: patches
  });

  return cb(null, self);
};

BaseBuffer.prototype.cancel_timeouts = function () {
  var self = this;
  _.each(self.get_buf_timeouts, function (timeout_id) {
    clearTimeout(timeout_id);
  });
  clearTimeout(self.save_timeout);
};

BaseBuffer.prototype.cancel_get_buf = function (agent) {
  var self = this;
  if (!agent) {
    return;
  }
  clearTimeout(self.get_buf_timeouts[agent.id]);
  delete self.get_buf_timeouts[agent.id];
};

BaseBuffer.prototype.send_get_buf = function (agent, delay) {
  var self = this;
  if (!agent) {
    return;
  }

  if (!_.isFinite(delay)) {
    delay = 1500;
  }

  self.cancel_get_buf(agent);
  self.get_buf_timeouts[agent.id] = setTimeout(function () {
    if (agent && !agent.disconnected) {
      agent.write("get_buf", self.to_json(agent));
      log.log("Sent get_buf to", agent.toString());
    }
    delete self.get_buf_timeouts[agent.id];
  }, delay);
};

BaseBuffer.prototype.patch = function (agent, patches, md5_before, md5_after) {
  var self = this,
    agent_state,
    agent_result,
    i,
    new_state,
    next_buf,
    prev_buf,
    result,
    rewind_patch = false,
    self_md5_after,
    self_md5_before = self._md5,
    undo_patches;

  if (self.encoding === "utf8") {
    // Kill windows newlines
    patches = patches.replace("%0D%0A", "%0A");
  }

  if (patches.length === 0) {
    log.log("Stupid client. Patch is empty.");
    return;
  }

  if (md5_before !== self_md5_before) {
    log.log("md5_before doesn't match. BE WARY!");
  }
  if (md5_after === self._md5) {
    log.log("md5_after matches current state", self._md5, "patch text:", patches);
  }

  if (md5_before !== self_md5_before || md5_after === self._md5) {
    for (i = 0; i < self.prev_bufs.length; i++) {
      prev_buf = self.prev_bufs[i];
      if (prev_buf.md5 === md5_before) {
        // TODO: unroll patches instead of storing a bunch of copies of previous buffers
        agent_state = prev_buf.buf;
        log.debug("applying patch", patches, "to", agent.toString(), "text");
        result = self.apply_patches_to_buffer(patches, agent_state);
        if (utils.patched_cleanly(result) === false) {
          log.error("Patch wasn't applied!", result);
          self.send_get_buf(agent, 0);
          return;
        }
        agent_state = result[0];
      }
      if (agent_state) {
        log.debug(agent.toString(), "text is", agent_state);
        next_buf = self.prev_bufs[i + 1];
        md5_after = utils.md5(agent_state);
        if (next_buf && md5_after === next_buf.md5) {
          log.debug(agent.toString(), "text matches current state. entering time machine.");
          rewind_patch = true;
        }
        log.debug("found matching previous md5. applying patch", prev_buf.patches);
        agent_result = self.apply_patches_to_buffer(prev_buf.patches, agent_state);
        if (!utils.patched_cleanly(agent_result)) {
          log.error("Patch wasn't applied!", agent_result);
          self.send_get_buf(agent, 0);
          return;
        }
        // TODO: build a DAG of md5s and patches
        agent_state = agent_result[0];
      }
    }
    if (agent_state) {
      if (rewind_patch) {
        undo_patches = DMP.patch_make(agent_state, self._state);
        log.log("undo patch:", undo_patches);
        agent.write("patch", {
          user_id: agent.id,
          username: agent.username,
          md5_before: utils.md5(agent_state),
          md5_after: self._md5,
          id: self.id,
          path: self.path,
          patch: undo_patches
        });
        self.cancel_get_buf();
        return;
      }
      md5_after = utils.md5(agent_state);
      // TODO: agent_state is a buffer, self._state is a buffer. these offsets could be wrong and cause patch weirdness
      patches = DMP.patch_make(self._state, agent_state);
      // TODO: maybe we want to send a patch (or not send one) to the out-of-date agent
      if (patches.length === 0) {
        log.log("Rolled forward and patch is empty. Our work here is done.");
        return;
      }
    } else {
      log.error(util.format("Sending get_buf to %s. No previous md5 matches %s.", agent.toString(), md5_before));
    }
  }

  log.debug("applying patch", patches, "to buf");
  result = self.apply_patches_to_buffer(patches, self._state);
  if (utils.patched_cleanly(result) === false) {
    log.error("Patch wasn't applied!", result);
    self.send_get_buf(agent, 0);
    return;
  }
  new_state = result[0];
  self_md5_after = utils.md5(new_state);
  if (self_md5_after !== md5_after) {
    log.error("md5 doesn't match! client:", md5_before, "->", md5_after, ". server:", self_md5_before, "->", self_md5_after, ". we should re-request the file but we don't");
    if (self_md5_before === md5_before) {
      log.error("Patch was applied cleanly from same starting position, but we got out of sync? WTF!?");
      log.error("Our final state: %s", result[0].toString());
      self.send_get_buf(agent, 0);
      return;
    }
    self.send_get_buf(agent, 1000);
  }

  prev_buf = self.to_prev_buf();
  prev_buf.patches = patches;
  self.prev_bufs.push(prev_buf);
  if (self.prev_bufs.length > settings.max_buf_history) {
    self.prev_bufs.shift();
  }
  self._state = new_state;
  self._md5 = self_md5_after;
  log.debug("%s updated. md5 was %s now %s", self.toString(), self_md5_before, self_md5_after);

  self.cancel_get_buf(agent);
  self.room.emit("dmp", agent, "patch", {
    user_id: agent.id,
    username: agent.username,
    md5_before: self_md5_before,
    md5_after: self_md5_after,
    id: self.id,
    path: self.path,
    patch: patches
  });

  agent._patch_count++;
  agent._patch_bytes += Math.abs(self._state.length - prev_buf.buf.length);

  self.save_timeout = self.save_timeout || setTimeout(function () {
    self.save(false, function () { return; });
    self.save_timeout = null;
  }, settings.save_delay);
};

BaseBuffer.prototype.highlight = function (agent, req) {
  var self = this,
    summon = !!req.ping || !!req.summon,
    highlight = {
      id: self.id,
      user_id: agent.id,
      username: agent.username,
      ranges: req.ranges,
      ping: summon,
      summon: summon,
      following: !!req.following
    };
  self.highlights[agent.id] = req.ranges;
  self.room.last_highlight = highlight;
  self.room.emit("dmp", agent, "highlight", highlight);
};


TextBuffer = function () {
  var self = this;

  self.encoding = "utf8";
  BaseBuffer.apply(self, _.toArray(arguments));
};

util.inherits(TextBuffer, BaseBuffer);

TextBuffer.prototype.apply_patches_to_buffer = function (patch_text, buf) {
  var patches,
    result;
  try {
    patches = JS_DMP.patch_fromText(patch_text);
  } catch (e) {
    log.error("Couldn't get patches from text:", e);
    return [buf, [0]];
  }
  result = JS_DMP.patch_apply(patches, buf.toString());
  result[0] = new Buffer(result[0]);
  return result;
};


BinaryBuffer = function () {
  var self = this;

  self.encoding = "base64";
  BaseBuffer.apply(self, _.toArray(arguments));
};

util.inherits(BinaryBuffer, BaseBuffer);

BinaryBuffer.prototype.apply_patches_to_buffer = function (patches, buf) {
  return DMP.patch_apply(patches, buf);
};

make_buffer = function (room, id, path, text, md5, create, encoding) {
  var state = text;

  if (_.isString(state)) {
    if (encoding === "utf8") {
      // Kill windows-style newlines.
      state = state.replace("\r\n", "\n");
    }
    state = new Buffer(state, encoding);
  }

  if (encoding === "utf8") {
    return new TextBuffer(room, id, path, state, md5, create);
  }
  if (encoding === "base64") {
    return new BinaryBuffer(room, id, path, state, md5, create);
  }

  throw new Error("Unsupported encoding:" + encoding);
};


SUPPORTED_ENCODINGS = {
  base64: BinaryBuffer,
  utf8: TextBuffer
};


module.exports = {
  make_buffer: make_buffer,
  BaseBuffer: BaseBuffer,
  TextBuffer: TextBuffer,
  BinaryBuffer: BinaryBuffer
};
