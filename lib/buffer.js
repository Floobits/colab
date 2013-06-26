var events = require("events");
var fs = require("fs");
var path = require("path");
var util = require("util");

var async = require("async");
var dmp_module = require("diff_match_patch");
var DMP = new dmp_module.diff_match_patch();
var _ = require("underscore");

var db = require("./db");
var log = require("./log");
var s3 = require("./s3");
var settings = require("./settings");
var utils = require("./utils");


var ColabBuffer = function (room, id, path, text, md5, create) {
  var self = this;
  self.guid = util.format("%s/%s", room.id, id);
  self.id = id;
  self.path = path;
  self.room = room;
  self._state = text || "";
  self.escape_unicode();
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
    self.save(create, function () {});
  } else {
    log.debug("loading buffer", self.guid);
  }
};

util.inherits(ColabBuffer, events.EventEmitter);

ColabBuffer.prototype.toString = function () {
  var self = this;
  return util.format("Buffer %s %s/%s md5 %s length %s", self.id, self.room, self.path, self._md5, self._state.length);
};

ColabBuffer.prototype.to_json = function () {
  var self = this;
  return {
    "path": self.path,
    "buf": self._state,
    "id": self.id,
    "md5": self._md5
  };
};

ColabBuffer.prototype.escape_unicode = function () {
  var self = this;

  self._state = self._state.replace(/([\ud800-\udfff])/g, function (match, cap, offset, string) {
    return "\\u" + ("0000" + cap.charCodeAt(0).toString(16)).slice(-4);
  });

  return self._state;
};

ColabBuffer.prototype.local_path = function () {
  var self = this;
  return path.normalize(path.join(self.room.path, self.id.toString()));
};

ColabBuffer.prototype.load = function (cb) {
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

ColabBuffer.prototype.load_local = function (cb) {
  var self = this;
  fs.readFile(self.local_path(), {encoding: "utf8"}, function (err, data) {
    if (err) {
      return cb(err, data);
    }
    self._state = data;
    self.escape_unicode();
    self._md5 = utils.md5(self._state);
    self.loaded = true;
    return cb(null, true);
  });
};

ColabBuffer.prototype.load_s3 = function (cb) {
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
      self._state = data;
      self.escape_unicode();
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

ColabBuffer.prototype.save = function (create, cb) {
  var self = this,
    args,
    auto = {},
    query,
    skip_save = (create !== true && self.saved_md5 === self._md5);

  if (skip_save) {
    log.debug("Buf", self.guid, "hasn't changed. Not saving to s3 or updating room.");
    return cb(null, self);
  }

  if (create) {
    query = "INSERT INTO room_buffer (fid, path, room_id, md5) VALUES ($1, $2, $3, $4)";
    args = [self.id, self.path, self.room.id, self._md5];
  } else {
    query = "UPDATE room_buffer SET path = $1, md5 = $2 WHERE room_id = $3 AND fid = $4";
    args = [self.path, self._md5, self.room.id, self.id];
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

ColabBuffer.prototype.save_local = function (cb) {
  var self = this;

  fs.writeFile(self.local_path(), self._state, cb);
};

ColabBuffer.prototype.save_s3 = function (cb) {
  var self = this,
    auto;

  auto = {
    put: function (cb) {
      var req,
        s3_client;

      s3_client = s3.get_client();
      req = s3_client.put(self.guid, {
        "Content-Length": Buffer.byteLength(self._state, "utf8"),
        "Content-Type": "text/plain"
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

ColabBuffer.prototype.cancel_timeouts = function () {
  var self = this;
  _.each(self.get_buf_timeouts, function (timeout_id, agent_id) {
    clearTimeout(timeout_id);
  });
};

ColabBuffer.prototype.cancel_get_buf = function (agent) {
  var self = this;
  if (!agent) {
    return;
  }
  clearTimeout(self.get_buf_timeouts[agent.id]);
};

ColabBuffer.prototype.send_get_buf = function (agent, delay) {
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

ColabBuffer.prototype.patch = function (agent, patch_text, md5_before, md5_after) {
  var self = this,
    agent_text,
    agent_result,
    clean_patch = true,
    i,
    next_buf,
    patches,
    prev_buf,
    result,
    rewind_patch = false,
    self_md5_after,
    self_md5_before = self._md5,
    undo_patches,
    update_patches;

  try {
    patches = DMP.patch_fromText(patch_text);
  } catch (e) {
    log.error("Couldn't parse patch text:", patch_text, "\nException:", e);
    agent.disconnect("Unable to parse the patch you sent.");
    return;
  }
  if (patches.length === 0) {
    log.log("Stupid client. Patch is empty.");
    return;
  }

  if (md5_before !== self_md5_before) {
    log.log("md5_before doesn't match. BE WARY!");
  }
  if (md5_after === self._md5) {
    log.log("md5_after matches current state", self._md5, "patch text:", patch_text);
  }

  if (md5_before !== self_md5_before || md5_after === self._md5) {
    for (i = 0; i < self.prev_bufs.length; i++) {
      prev_buf = self.prev_bufs[i];
      if (prev_buf.md5 === md5_before) {
        // TODO: unroll patches instead of storing a bunch of copies of previous buffers
        agent_text = prev_buf.buf;
        log.debug("applying patch", DMP.patch_toText(patches), "to", agent.toString(), "text");
        result = DMP.patch_apply(patches, agent_text);
        if (utils.patched_cleanly(result) === false) {
          log.error("Patch wasn't applied!", result);
          self.send_get_buf(agent, 0);
          return;
        }
        agent_text = result[0];
      }
      if (agent_text) {
        log.debug(agent.toString(), "text is", agent_text);
        next_buf = self.prev_bufs[i + 1];
        md5_after = utils.md5(agent_text);
        if (next_buf && md5_after === next_buf.md5) {
          log.debug(agent.toString(), "text matches current state. entering time machine.");
          rewind_patch = true;
        }
        log.debug("found matching previous md5. applying patch", DMP.patch_toText(prev_buf.patches));
        agent_result = DMP.patch_apply(prev_buf.patches, agent_text);
        if (!utils.patched_cleanly(agent_result)) {
          log.error("Patch wasn't applied!", agent_result);
          self.send_get_buf(agent, 0);
          return;
        }
        // TODO: build a DAG of md5s and patches
        agent_text = agent_result[0];
      }
    }
    if (agent_text) {
      if (rewind_patch) {
        undo_patches = DMP.patch_make(agent_text, self._state);
        log.log("undo patch:", DMP.patch_toText(undo_patches));
        agent.write("patch", {
          user_id: agent.id,
          username: agent.username,
          md5_before: utils.md5(agent_text),
          md5_after: self._md5,
          id: self.id,
          path: self.path,
          patch: DMP.patch_toText(undo_patches)
        });
        self.cancel_get_buf();
        return;
      }
      md5_after = utils.md5(agent_text);
      patches = DMP.patch_make(self._state, agent_text);
      // TODO: maybe we want to send a patch (or not send one) to the out-of-date agent
      if (patches.length === 0) {
        log.log("Rolled forward and patch is empty. Our work here is done.");
        return;
      }
    } else {
      log.error(util.format("Sending get_buf to %s. No previous md5 matches %s.", agent.toString(), md5_before));
    }
  }

  log.debug("applying patch", DMP.patch_toText(patches), "to buf");
  result = DMP.patch_apply(patches, self._state);
  if (utils.patched_cleanly(result) === false) {
    log.error("Patch wasn't applied!", result);
    self.send_get_buf(agent, 0);
    return;
  }

  self_md5_after = utils.md5(result[0].toString());
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

  prev_buf = self.to_json();
  prev_buf.patches = patches;
  self.prev_bufs.push(prev_buf);
  if (self.prev_bufs.length > settings.max_buf_history) {
    self.prev_bufs.shift();
  }
  self._state = result[0];
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
    patch: DMP.patch_toText(patches)
  });
  self.save_timeout = self.save_timeout || setTimeout(function () {
    self.save(false, function () {});
    self.save_timeout = null;
  }, settings.save_delay);
};

ColabBuffer.prototype.highlight = function (agent, ranges, ping) {
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

module.exports = ColabBuffer;
