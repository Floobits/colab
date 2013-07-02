var events = require("events");
var fs = require("fs");
var path = require("path");
var util = require("util");

var async = require("async");
var DMP = require("native-diff-match-patch");
var diff_match_patch = require('diff_match_patch');
var JS_DMP = new diff_match_patch.diff_match_patch();

var _ = require("underscore");

var db = require("./db");
var log = require("./log");
var s3 = require("./s3");
var settings = require("./settings");
var utils = require("./utils");


var BaseBuffer = function (room, id, path, state, md5, create) {
  var self = this;
  self.guid = util.format("%s/%s", room.id, id);
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
  self.patch_timeout = null;
  self.save_timeout = null;
  self.get_buf_timeouts = {};

  if (create) {
    log.debug("created new buffer", self.guid);
    self.loaded = true;
    self.save(create, function (err, result) {
      if (err) {
        // TODO: bubble this up to someone who can deal with it
        log.error("ERROR SAVING BUFFER AFTER CREATION:", err);
      }
    });
  } else {
    log.debug("loading buffer", self.guid);
  }
};

util.inherits(BaseBuffer, events.EventEmitter);

BaseBuffer.prototype.toString = function () {
  var self = this;
  return util.format("Buffer %s %s/%s md5 %s length %s", self.id, self.room, self.path, self._md5, self._state.length);
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

BaseBuffer.prototype.to_json = function () {
  var self = this;
  return _.extend(self.to_room_info(), {buf: self._state.toString(self.encoding)});
};

BaseBuffer.prototype.to_prev_buf = function () {
  var self = this;
  return _.extend(self.to_room_info(), {buf: self._state});
};

BaseBuffer.prototype.local_path = function () {
  var self = this;
  return path.normalize(path.join(self.room.path, self.id.toString()));
};

BaseBuffer.prototype.load = function (cb) {
  var self = this,
    auto;

  auto = {
    local: function (cb) {
      if (!settings.buf_storage.local) {
        return cb();
      }
      return self.load_local(utils.squelch(cb));
    },
    s3: ["local", function (cb, res) {
      if (!settings.buf_storage.s3 || res.local === true) {
        return cb();
      }
      return self.load_s3(function (err, result) {
        if (settings.buf_storage.local && res.local !== true) {
          return self.save_local(cb);
        }
        return cb(err, result);
      });
    }]
  };

  async.auto(auto, function (err, res) {
    if (err) {
      return cb(err, res);
    }
    if (self.loaded !== true) {
      self.emit("load_error");
      return cb("Couldn't load buffer!", res);
    }
    self.emit("load");
    log.log("loaded buffer", self.guid, self.path);
    return cb(null, self);
  });
};

BaseBuffer.prototype.load_local = function (cb) {
  var self = this;
  fs.readFile(self.local_path(), function (err, data) {
    if (err) {
      return cb(err, data);
    }
    self._state = new Buffer(data);
    self._md5 = utils.md5(self._state);
    self.loaded = true;
    return cb(null, true);
  });
};

BaseBuffer.prototype.load_s3 = function (cb) {
  var self = this,
    s3_client = s3.get_client(),
    req = s3_client.get(self.guid);
  cb = cb || function () {};

  req.on("response", function (res) {
    var data = "";
    if (res.statusCode >= 400) {
      return cb(util.format("Bad status code from S3: %s", res.statusCode));
    }
    res.on("data", function (chunk) {
      data += chunk;
    });
    res.on("end", function () {
      self._state = new Buffer(data);
      self._md5 = utils.md5(self._state);
      self.loaded = true;
      cb(null, self);
    });
    res.on("error", cb);
  });
  req.on("error", function (err, result) {
    log.error("S3 request error:", err);
    cb(util.format("S3 request error:", err));
  });
  req.end();
};

BaseBuffer.prototype.save = function (create, cb) {
  var self = this,
    args,
    auto = {},
    encoding_id = db.buf_encodings_reverse[self.encoding],
    query,
    skip_save = (create !== true && self.saved_md5 === self._md5);

  if (_.isUndefined(encoding_id)) {
    log.error("encoding is " + self.encoding);
  }

  if (skip_save) {
    log.debug("Buf", self.guid, "hasn't changed. Not saving to s3 or updating room.");
    return cb(null, self);
  }

  if (create) {
    query = "INSERT INTO room_buffer (fid, path, room_id, md5, encoding) VALUES ($1, $2, $3, $4, $5)";
    args = [self.id, self.path, self.room.id, self._md5, encoding_id];
  } else {
    query = "UPDATE room_buffer SET path = $1, md5 = $2, encoding = $3 WHERE room_id = $4 AND fid = $5";
    args = [self.path, self._md5, encoding_id, self.room.id, self.id];
  }

  auto.db = function (cb) {
    db.client.query(query, args, cb);
  };

  if (settings.buf_storage.s3) {
    auto.s3 = ["db", self.save_s3.bind(self)];
  }
  if (settings.buf_storage.local) {
    auto.local = ["db", self.save_local.bind(self)];
  }

  async.auto(auto, function (err, res) {
    if (err) {
      cb(err, res);
    }
    self.room.save(cb);
  });
};

BaseBuffer.prototype.save_local = function (cb) {
  var self = this;

  fs.writeFile(self.local_path(), self._state, cb);
};

BaseBuffer.prototype.save_s3 = function (cb) {
  var self = this,
    auto;

  auto = {
    put: function (cb) {
      var req,
        s3_client;

      s3_client = s3.get_client();
      req = s3_client.put(self.guid, {
        "Content-Length": self._state.length,
        "Content-Type": "application/octet-stream"
      });
      req.on("response", function (res) {
        if (res.statusCode === 200) {
          return cb();
        }
        log.error("error saving buf", self.guid, "to s3");
        return cb("status code: " + res.statusCode);
      });
      req.on("error", function (err) {
        log.error("Error saving buffer", self.guid, "to s3");
      });
      req.end(self._state);
    }
  };

  async.auto(auto, function (err, result) {
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
};

BaseBuffer.prototype.cancel_timeouts = function () {
  var self = this;
  _.each(self.get_buf_timeouts, function (timeout_id, agent_id) {
    clearTimeout(timeout_id);
  });
};

BaseBuffer.prototype.cancel_get_buf = function (agent) {
  var self = this;
  if (!agent) {
    return;
  }
  clearTimeout(self.get_buf_timeouts[agent.id]);
};

BaseBuffer.prototype.send_get_buf = function (agent, delay) {
  var self = this;
  if (!agent) {
    return;
  }

  self.cancel_get_buf(agent);
  self.get_buf_timeouts[agent.id] = setTimeout(function () {
    if (agent && !agent.disconnected) {
      agent.write("get_buf", self.to_json());
    }
  }, delay || 1500);
};

BaseBuffer.prototype.apply_patches = function (patches, buf) {
  var self = this,
    p,
    native_result,
    js_result;
  if (_.isString(patches)) {
    p = JS_DMP.patch_fromText(patches);
  }
  native_result = DMP.patch_apply(patches, buf);
  js_result = JS_DMP.patch_apply(p, buf.toString());
  if (native_result[0].toString() !== js_result[0]) {
    log.warn(native_result);
    log.warn(native_result[0].toString());
    log.warn(native_result);
    log.error('oh shit!?\n\n\n\n');
    return js_result;
  }
  return native_result;
};

BaseBuffer.prototype.patch = function (agent, patches, md5_before, md5_after) {
  var self = this,
    agent_state,
    agent_result,
    clean_patch = true,
    i,
    new_state,
    next_buf,
    prev_buf,
    result,
    rewind_patch = false,
    self_md5_after,
    self_md5_before = self._md5,
    undo_patches,
    update_patches;

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
        result = self.apply_patches(patches, agent_state);
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
        agent_result = self.apply_patches(prev_buf.patches, agent_state);
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
      console.log(self._state);
      console.log(agent_state);
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
  result = self.apply_patches(patches, self._state);
  if (utils.patched_cleanly(result) === false) {
    log.error("Patch wasn't applied!", result);
    self.send_get_buf(agent, 0);
    return;
  }
  new_state = new Buffer(result[0]);
  self_md5_after = utils.md5(new_state);
  if (self_md5_after !== md5_after) {
    log.error("md5 doesn't match! client:", md5_before, "->", md5_after, ". server:", self_md5_before, "->", self_md5_after, ". we should re-request the file but we don't");
    if (self_md5_before === md5_before) {
      log.error("Patch was applied cleanly from same starting position, but we got out of sync? WTF!?");
      log.error("our final state:" + result[0].toString());
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
  log.debug("buf", self.guid, self.path, "updated. md5 was", self_md5_before, "now", self_md5_after);

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
  self.save_timeout = self.save_timeout || setTimeout(function () {
    self.save(false, function () {});
    self.save_timeout = null;
  }, settings.save_delay);
};

BaseBuffer.prototype.highlight = function (agent, ranges, ping) {
  var self = this,
    highlight = {
      id: self.id,
      user_id: agent.id,
      username: agent.username,
      ranges: ranges,
      ping: !!ping
    };
  self.highlights[agent.id] = ranges;
  self.room.last_highlight = highlight;
  self.room.emit("dmp", agent, "highlight", highlight);
};


var TextBuffer = function (room, id, path, text, md5, create) {
  var self = this;

  self.encoding = "utf8";
  BaseBuffer.apply(self, _.toArray(arguments));
};

util.inherits(TextBuffer, BaseBuffer);


var BinaryBuffer = function (room, id, path, text, md5, create) {
  var self = this;

  self.encoding = "base64";
  BaseBuffer.apply(self, _.toArray(arguments));
};

util.inherits(BinaryBuffer, BaseBuffer);


var make_buffer = function (room, id, path, text, md5, create, encoding) {
  var state = text;

  console.log("making buffer " + text + "encoding" + encoding);

  if (_.isString(state)) {
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

module.exports = {
  make_buffer: make_buffer,
  BaseBuffer: BaseBuffer,
  TextBuffer: TextBuffer,
  BinaryBuffer: BinaryBuffer
};
