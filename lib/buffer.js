"use strict";

const events = require("events");
const util = require("util");
const basename = require("path").basename;

const async = require("async");
const log = require("floorine");
const mime = require("mime-types");
const DMP = require("native-diff-match-patch");
const Diff_Match_Patch = require("dmp");
const JS_DMP = new Diff_Match_Patch();
const _ = require("lodash");

const MSG = require("./msg");
const settings = require("./settings");
const utils = require("./utils");

/* Strip all \r. It should never show up in a text buffer, and
 * some clients (Atom) occasionally send patches with just \r.
 */
/*eslint-disable no-control-regex */
const CRRegex = new RegExp("\r", "g");
/*eslint-enable no-control-regex */
const CRPatch = "%0D";

JS_DMP.Patch_DeleteThreshold = settings.dmp.Patch_DeleteThreshold;
JS_DMP.Match_Threshold = settings.dmp.Match_Threshold;
JS_DMP.Match_Distance = settings.dmp.Match_Distance;

const CommentRegex = new RegExp("\\/\\*[\\S\\s]*?\\*\\/", "g");
const EmptyLineRegex = new RegExp("^\\s*$", "g");

// Defaults:
// Patch_DeleteThreshold = 0.5;
// Match_Threshold = 0.5;
// Match_Distance = 1000;
DMP.set_Patch_DeleteThreshold(settings.dmp.Patch_DeleteThreshold);
DMP.set_Match_Threshold(settings.dmp.Match_Threshold);
DMP.set_Match_Distance(settings.dmp.Match_Distance);

let SUPPORTED_ENCODINGS;

const LOAD_STATES = {
  NOT_LOADING: 1,
  LOADING: 2,
  LOADED: 3,
};
const LOAD_STATES_REVERSE = _.invert(LOAD_STATES);

const BaseBuffer = function (room, id, path, state, md5, create) {
  var self = this;

  events.EventEmitter.call(self);

  self.id = id;
  self.path = path;
  self.room = room;
  self._state = state;
  self._md5 = md5;
  self._last_state = self._state;
  self._last_md5 = self._md5;
  self.saved_md5 = self._md5;

  self.prev_bufs = [];
  self.load_state = LOAD_STATES.NOT_LOADING;
  self.save_timeout = null;
  self.get_buf_timeouts = {};

  self.db_key = util.format("buf_%s", self.id);
  self.content_key = util.format("buf_content_%s", self.id);

  if (create) {
    self._state = self.normalize(state);
    self._md5 = utils.md5(self._state);
    log.debug("created new buffer", self.toString());
    self.load_state = LOAD_STATES.LOADED;
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
  var self = this,
    room_str = self.room ? self.room.toString() : "[NO ROOM]",
    length;
  length = self._state ? self._state.length : 0;
  return util.format("Buffer %s %s/%s md5 %s length %s", self.id, room_str, self.path, self._md5, length);
};

BaseBuffer.prototype.get_db_encoding = function () {
  var self = this;
  return self.encoding === "utf8" ? "utf8" : "binary";
};

BaseBuffer.prototype.get_extension = function () {
  var self = this;
  return self.path.split(".").slice(-1);
};

BaseBuffer.prototype.detect_indentation = function () {
  const self = this;
  let totals = {
    tabs: 0,
    spaces: 0
  };

  if (!self._state || self.encoding !== "utf8") {
    return null;
  }

  // Only analyze first 10K of buffer
  const buf = self._state.slice(0, 10000).toString("utf8");

  // Kill multi-line comments
  let stripped_buf = buf.replace(CommentRegex, "\n");
  // Kill empty lines
  stripped_buf = stripped_buf.replace(EmptyLineRegex, "");

  // We just want leading whitespace count on each line. Also, only process first 100 lines of buf.
  let whitespace = _.map(stripped_buf.split("\n").slice(0, 100), function (line) {
    const counts = {
      tabs: 0,
      spaces: 0
    };
    let eows = line.search(/[^\s]/);
    if (eows === -1) {
      eows = line.length;
    }
    line = line.slice(0, eows);
    counts.tabs = line.split("\t").length - 1;
    counts.spaces = line.split(" ").length - 1;
    totals.tabs += counts.tabs;
    totals.spaces += counts.spaces;
    return counts;
  });

  log.debug("indent totals: tabs %s spaces %s", totals.tabs, totals.spaces);

  // Definitely need to tweak this
  if (totals.tabs * 2 > totals.spaces) {
    log.debug("TABS");
    return "\t";
  }

  function count(c, i) {
    return (c.spaces / i) % 1 === 0;
  }

  let best = 0;
  let good;
  let indent = null;
  for (let i = 2; i < 5; i++) {
    good = _.filter(whitespace, count).length;
    log.debug("%s has %s good", i, good);
    if (good > best) {
      indent = i;
    }
  }

  log.debug("%s spaces", indent);
  indent = "         ".slice(0, indent);

  return indent;
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

  if (agent && !_.includes(agent.supported_encodings, self.encoding)) {
    encoding = "utf8";
  }

  return _.extend(self.to_room_info(), {buf: self._state.toString(encoding)});
};

BaseBuffer.prototype.to_prev_buf = function () {
  var self = this;
  return _.extend(self.to_room_info(), {buf: self._state});
};

BaseBuffer.prototype.normalize = function (state) {
  var self = this;

  if (_.isString(state)) {
    state = new Buffer(state, self.encoding);
  }
  return state;
};

BaseBuffer.prototype.handle_indentation = function (agent, patches, md5_before, md5_after) {
  return [patches, md5_before, md5_after];
};

BaseBuffer.prototype.handle_newlines = function (agent, patches, md5_before, md5_after) {
  return [patches, md5_before, md5_after];
};

BaseBuffer.prototype.load = function (cb) {
  var self = this,
    buf_md5;

  if (self.load_state === LOAD_STATES.LOADED) {
    return cb(null, self);
  }

  self.once("load", cb);
  if (self.load_state === LOAD_STATES.LOADING) {
    return null;
  }

  self.load_state = LOAD_STATES.LOADING;

  self.room.db.get(self.content_key, { valueEncoding: "binary" }, function (err, result) {
    if (!err) {
      self._state = self.normalize(result);
    } else if (err.type === "NotFoundError") {
      log.debug("Buffer %s content not found. Setting to empty.", self.toString());
      self._state = new Buffer(0);
    } else {
      // TODO: could cause lots of wasted resources if people keep trying to load this buffer
      self.load_state = LOAD_STATES.NOT_LOADED;
      return self.emit("load", err, self);
    }

    buf_md5 = utils.md5(self._state);
    if (self._md5 !== buf_md5) {
      log.warn("MD5 mismatch when loading %s! Was %s. Should be %s", self.toString(), buf_md5, self._md5);
      self._md5 = buf_md5;
      // Correct checksum will be saved eventually, since saved_md5 !== self._md5
    }
    self.load_state = LOAD_STATES.LOADED;
    return self.emit("load", null, self);
  });
};

BaseBuffer.prototype.load_then_call = function (f, args) {
  var self = this;

  self.load(function (err) {
    if (err) {
      const agent = args[0];
      const req_id = args[1];
      return agent.error(req_id, util.format("Server error loading %s: %s", self.path, err));
    }
    return f.apply(self, args);
  });
};

BaseBuffer.prototype.dirtify = function () {
  var self = this,
    now,
    save_delay = settings.save_delay;

  if (self.save_timeout) {
    return;
  }

  now = Date.now();
  if (now - self.room.updated_at > save_delay) {
    // Hasn't been saved to DB in a long time, so save now.
    save_delay = 1;
  }

  self.save_timeout = setTimeout(function () {
    self.save(false, function (err) {
      if (err) {
        log.error("Error saving buf %s in save_timeout: %s", self.toString(), err);
      }
      self.save_timeout = null;
    });
  }, save_delay);
};

BaseBuffer.prototype.cleanup = function () {
  var self = this;

  if (self.save_timeout) {
    log.warn("%s cleanup: save_timeout exists. This should never happen.", self.toString());
  }
  self.removeAllListeners("load");
  self.cancel_timeouts();
  self.room = null;
  self._state = null;
};

BaseBuffer.prototype.save = function (force, cb) {
  var self = this,
    actions = [],
    saved_md5 = self._md5,
    skip_save = (force !== true && self.saved_md5 === self._md5);

  if (skip_save) {
    return cb(null, self);
  }

  log.debug("Saving %s", self.toString());
  self.room.dirtify();

  if (!self.room.db) {
    // TODO: so lame. Figure out where we're not cancelling the timeout.
    return cb(util.format("No db for %s", self.toString()), self);
  }

  actions.push((info_cb) => {
    self.room.db.put(self.db_key, {
      id: self.id,
      path: self.path,
      deleted: false,
      md5: self._md5,
      encoding: self.encoding,
    }, {
      valueEncoding: "json",
    }, info_cb);
  });

  if (self.load_state === LOAD_STATES.LOADED) {
    if (self._state.length > 0) {
      actions.push((content_cb) => {
        self.room.db.put(self.content_key, self._state, { valueEncoding: "binary" }, content_cb);
      });
    } else {
      actions.push((del_cb) => {
        self.room.db.del(self.content_key, function (err) {
          if (err && err.type === "NotFoundError") {
            err = null;
          }
          return del_cb(err);
        });
      });
    }
  }

  async.parallel(actions, function (err) {
    log.debug("Saved %s. Error: %s", self.toString(), err);
    if (!err) {
      self.saved_md5 = saved_md5;
      // We just saved, so clear any save timeout.
      clearTimeout(self.save_timeout);
      self.save_timeout = null;
    }
    return cb(err);
  });
};

BaseBuffer.prototype.set = function (agent, req_id, state, md5, encoding, broadcast, cb) {
  var self = this,
    data,
    patches,
    self_md5_before = self._md5;

  cb = cb || function () { return; };

  if (self.load_state !== LOAD_STATES.LOADED) {
    return self.load_then_call(self.set, arguments);
  }

  if (self.encoding !== encoding) {
    return self.room.delete_buf(agent, req_id, self.id, true, function (err) {
      if (err) {
        return cb(err);
      }
      self.room.create_buf(agent, req_id, self.path, state, encoding, function (create_err, result) {
        log.debug("Reset buffer ", self.id, self.path);
        return cb(create_err, result);
      });
    });
  }

  if (!_.has(SUPPORTED_ENCODINGS, encoding)) {
    return cb(util.format("Unsupported encoding: '%s'", encoding));
  }

  // Don't do anything if md5 is the same
  if (md5 === self._md5) {
    if (!broadcast) {
      agent.ack(req_id);
    }
    return cb(null, self);
  }

  state = self.normalize(state);
  if (encoding === "utf8") {
    patches = JS_DMP.patch_make(self._state.toString(), state.toString());
    try {
      patches = JS_DMP.patch_toText(patches);
    } catch (e) {
      // TODO: fork and fix DMP, or something else
      log.error("ERROR GENERATING PATCHES IN SET_BUF %s", self.toString());
      log.error(e);
    }
  } else {
    patches = DMP.patch_make(self._state, state);
  }

  self.cancel_get_buf(agent);

  log.debug("Set buffer", self.id, self.path);
  self._state = state;
  self._md5 = utils.md5(self._state);
  if (md5 && self._md5 !== md5) {
    log.warn(util.format("%s client md5 sum doesn't match: %s", self.toString(), md5));
  }

  // TODO: rate limit?
  if (!broadcast) {
    const msg = new MSG(agent, util.format("%s overwrote %s", agent.username, self.path));
    self.room.broadcast("msg", agent, null, msg.to_json());
  }

  if (patches.length === 0) {
    if (encoding === "utf8") {
      log.log("states:\n%s\n%s", this._state.toString(), state.toString());
      log.warn("WTF. Patches length is zero. normalized md5: %s current md5: %s", utils.md5(state), self._md5);
    }
    // TODO: broadcast is a proxy for whether or not we're pulling from repo.
    // we don't want to send lots of acks in that case. this is horrible
    if (!broadcast) {
      self.room.broadcast("get_buf", agent, req_id, self.to_json());
    }
    return cb(null, self);
  }

  data = {
    user_id: agent.id,
    username: agent.username,
    md5_before: self_md5_before,
    md5_after: self._md5,
    id: self.id,
    path: self.path,
    patch: patches
  };
  if (broadcast) {
    self.room.broadcast("patch", null, null, data);
  } else {
    self.room.broadcast("patch", agent, req_id, data);
  }

  self.dirtify();
  return cb(null, self);
};

BaseBuffer.prototype.cancel_timeouts = function () {
  var self = this;
  _.each(self.get_buf_timeouts, function (gbt) {
    clearTimeout(gbt.timeout_id);
  });
  self.get_buf_timeouts = {};
  clearTimeout(self.save_timeout);
  self.save_timeout = null;
};

BaseBuffer.prototype.cancel_get_buf = function (agent) {
  var self = this,
    gbt;
  if (!agent) {
    return;
  }
  gbt = self.get_buf_timeouts[agent.id];
  if (gbt) {
    clearTimeout(gbt.timeout_id);
    delete self.get_buf_timeouts[agent.id];
  }
};

BaseBuffer.prototype.send_get_buf = function (agent, req_id, delay) {
  const self = this;

  if (!_.isFinite(delay)) {
    delay = 1500;
  }

  // TODO: almost certainly leaking event emitters here
  if (self.load_state !== LOAD_STATES.LOADED) {
    return self.load_then_call(self.send_get_buf, arguments);
  }

  const gbt = self.get_buf_timeouts[agent.id];
  if (gbt) {
    agent.ack(gbt.req_id);
  }
  self.cancel_get_buf(agent);

  self.get_buf_timeouts[agent.id] = {req_id: req_id, timeout_id: setTimeout(function () {
    if (self._state) {
      agent.write("get_buf", req_id, self.to_json(agent));
      log.log("Sent get_buf to %s for\n%s", agent.toString(), self.toString());
    } else {
      log.error(`get_buf_timeouts[${agent.id}] sent with no state. We should have cleared this!`);
    }
    delete self.get_buf_timeouts[agent.id];
  }, delay)};
};

BaseBuffer.prototype.time_machine = function (agent, md5_before, patches) {
  const self = this;

  let agent_state;
  // let rewind_patch;
  // let patch_from;
  for (let i = self.prev_bufs.length - 1; i >= 0; i--) {
    const prev_buf = self.prev_bufs[i];
    if (prev_buf.md5 !== md5_before) {
      continue;
    }

    // TODO: we could apply the patch the client sent multiple times (undo)
    // TODO: unroll patches instead of storing a bunch of copies of previous buffers
    agent_state = prev_buf.buf;
    log.debug("applying patch from wire", patches, "to", agent.toString(), "text");
    const result = self.apply_patches_to_buffer(patches, agent_state);
    if (utils.patched_cleanly(result) === false) {
      log.error("Patch wasn't applied!", result);
      return null;
    }
    agent_state = result[0];
    // patch_from = i;
    break;
  }

  // Client's state doesn't match anything we have. Give up.
  if (!agent_state) {
    return null;
  }

  return [agent_state, false];

  // for (let i = patch_from; i < self.prev_bufs.length; i++) {
  //   log.debug(agent.toString(), "text is", agent_state);
  //   const next_buf = self.prev_bufs[i + 1];
  //   const md5_after = utils.md5(agent_state);
  //   if (next_buf && md5_after === next_buf.md5) {
  //     log.debug(agent.toString(), "text matches current state. entering time machine.");
  //     rewind_patch = true;
  //   }
  //   log.debug("found matching previous md5");
  //   log.debug("applying patch [-%s] from the past by %s from %s to %s text", (self.prev_bufs.length - i), prev_buf.agent, prev_buf.patches, agent_state);
  //   const result = self.apply_patches_to_buffer(prev_buf.patches, agent_state);
  //   if (!utils.patched_cleanly(result)) {
  //     log.error("Patch wasn't applied!", result);
  //     return null;
  //   }
  //   // TODO: build a DAG of md5s and patches
  //   agent_state = result[0];
  // }
  // return [agent_state, rewind_patch];
};

BaseBuffer.prototype.patch = function (agent, req_id, patches, md5_before, md5_after) {
  if (patches.length === 0) {
    log.log("Stupid client. Patch is empty.");
    agent.ack(req_id);
    return;
  }

  const self = this;
  if (self.load_state !== LOAD_STATES.LOADED) {
    self.load_then_call(self.patch, arguments);
    return;
  }

  let self_md5_before = self._md5;
  if (md5_before !== self_md5_before) {
    log.log("md5_before doesn't match. BE WARY!");
  }

  [patches, md5_before, md5_after] = self.handle_indentation(agent, patches, md5_before, md5_after);
  [patches, md5_before, md5_after] = self.handle_newlines(agent, patches, md5_before, md5_after);

  if (md5_after === self._md5) {
    log.log("md5_after matches current state", self._md5, "patch text:", patches);
    agent.ack(req_id);
    return;
  }

  // let rewind_patch = false;
  // let agent_state;
  if ((md5_before && md5_before !== self_md5_before) || (md5_before && md5_after === self._md5)) {
    // Client's state is out of sync. Maybe due to latency, maybe something else.
    self.send_get_buf(agent, req_id); // Queue up a get_buf
    // const x = self.time_machine(agent, md5_before, patches);
    // if (!x) {
    //   log.debug("%s agent %s no previous state for md5 %s", self.toString(), agent.toString(), md5_before);
    //   self.send_get_buf(agent, req_id, 1000);
    //   return;
    // }
    // agent_state = x[0];
    // rewind_patch = x[1];
  }

  // let undo_patches;
  // if (agent_state && rewind_patch) {
  //   if (self.encoding === "utf8") {
  //     undo_patches = JS_DMP.patch_make(agent_state.toString(), self._state.toString());
  //     undo_patches = JS_DMP.patch_toText(undo_patches);
  //   } else {
  //     undo_patches = DMP.patch_make(agent_state, self._state);
  //   }

  //   log.log("%s undo patch: %s", self.toString(), undo_patches);
  //   agent.write("patch", req_id, {
  //     user_id: agent.id,
  //     username: agent.username,
  //     md5_before: utils.md5(agent_state),
  //     md5_after: self._md5,
  //     id: self.id,
  //     path: self.path,
  //     patch: undo_patches
  //   });
  //   self.cancel_get_buf(agent);
  //   return;
  // }

  // if (agent_state) {
  //   log.log("generating (roll-forward) patches");
  //   // TODO !! we stomp on md5_after/patches
  //   md5_after = utils.md5(agent_state);
  //   // TODO: agent_state is a buffer, self._state is a buffer. these offsets could be wrong and cause patch weirdness
  //   if (self.encoding === "utf8") {
  //     patches = JS_DMP.patch_make(self._state.toString(), agent_state.toString());
  //     patches = JS_DMP.patch_toText(patches);
  //   } else {
  //     patches = DMP.patch_make(self._state, agent_state);
  //   }

  //   // TODO: maybe we want to send a patch (or not send one) to the out-of-date agent
  //   if (patches.length === 0) {
  //     agent.ack(req_id);
  //     log.log("Rolled forward and patch is empty. Our work here is done.");
  //     return;
  //   }
  // }

  log.debug("applying patch 3", patches, "to buf");
  const result = self.apply_patches_to_buffer(patches, self._state);
  if (utils.patched_cleanly(result) === false) {
    log.error("Patch wasn't applied!", result);
    self.send_get_buf(agent, req_id, 0);
    return;
  }
  const new_state = result[0];
  const self_md5_after = utils.md5(new_state);
  if (self_md5_after !== md5_after) {
    log.error("md5 doesn't match! client:", md5_before, "->", md5_after, ". server:", self_md5_before, "->", self_md5_after, ". we should re-request the file but we don't");
    if (self_md5_before === md5_before) {
      log.error("Patch was applied cleanly from same starting position, but we got out of sync? WTF!?");
      log.error("Our final state: %s", result[0].toString());
      self.send_get_buf(agent, req_id, 0);
      return;
    }

    self.send_get_buf(agent, req_id, 1000);
  }

  const prev_buf = self.to_prev_buf();
  prev_buf.patches = patches;
  prev_buf.agent = agent.toString();
  self.prev_bufs.push(prev_buf);
  if (self.prev_bufs.length > settings.max_buf_history) {
    self.prev_bufs.shift();
  }
  self._state = new_state;
  self._md5 = self_md5_after;
  log.debug("%s updated. md5 was %s now %s", self.toString(), self_md5_before, self_md5_after);

  self.cancel_get_buf(agent);
  self.room.broadcast("patch", agent, req_id, {
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

  self.dirtify();
};


const TextBuffer = function () {
  var self = this;

  self.encoding = "utf8";
  BaseBuffer.apply(self, arguments);
};

util.inherits(TextBuffer, BaseBuffer);

TextBuffer.prototype.get_content_type = function () {
  var self = this;
  return mime.contentType(self.get_extension()) || "text/plain; charset=utf-8";
};

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

TextBuffer.prototype.handle_indentation = function (agent, patches, md5_before, md5_after) {
  const has_tabs = patches.includes("%09");
  const has_spaces = patches.includes("%20%20%20%20");
  if (!has_tabs && !has_spaces) {
    return [patches, md5_before, md5_after];
  }
  const indentation_msg = "Possible indentation mismatch! %s is indented with %s, but %s sent %s.";
  const indent = this.detect_indentation();
  const filename = basename(this.path);
  if (has_tabs && indent !== "\t") {
    log.warn("%s probably has incorrect indentation rules. Patch contains a tab.", agent.toString());
    utils.rate_limit(agent.toString(), settings.indent_error_limit, () => {
      agent.error(null, util.format(indentation_msg, filename, "spaces", "you", "tabs") + " Check your indentation rules!", false);
      const msg = new MSG(agent, util.format(indentation_msg, filename, "spaces", agent.username, "tabs"));
      this.room.broadcast("msg", agent, null, msg.to_json());
    });
    // TODO: probably don't want to always do this.
    // patches = patches.replace("%09", encodeURIComponent(indent));
    // md5_after = null;
  } else if (has_spaces && indent === "\t") {
    log.warn("%s probably has incorrect indentation rules. Patch contains spaces.", agent.toString());
    utils.rate_limit(agent.toString(), settings.indent_error_limit, () => {
      agent.error(null, util.format(indentation_msg, filename, "tabs", "you", "spaces") + " Check your indentation rules!", false);
      const msg = new MSG(agent, util.format(indentation_msg, filename, "tabs", agent.username, "spaces"));
      this.room.broadcast("msg", agent, null, msg.to_json());
    });
    // TODO: probably don't want to always do this.
    // patches = patches.replace("%20%20%20%20", encodeURIComponent(indent));
    // md5_after = null;
  }
  return [patches, md5_before, md5_after];
};

TextBuffer.prototype.handle_newlines = function (agent, patch_text, md5_before, md5_after) {
  const has_cr = patch_text.includes(CRPatch);
  if (!has_cr) {
    return [patch_text, md5_before, md5_after];
  }
  const cr_msg = "%s editor sent a carriage return in %s.";
  utils.rate_limit(agent.toString(), settings.cr_error_limit, () => {
    const filename = basename(this.path);
    agent.error(null, util.format(cr_msg, "Your", filename) + " Check your newline rules!", false);
    const msg = new MSG(agent, util.format(cr_msg, agent.username + "'s", filename));
    this.room.broadcast("msg", agent, null, msg.to_json());
  });

  // Kill windows newlines
  // parse patch, fix offsets, kill CRs
  let patches;
  try {
    patches = JS_DMP.patch_fromText(patch_text);
  } catch (e) {
    log.error("Couldn't get patches from text:", e);
    return [patch_text, null, null];
  }

  // TODO: recalculate initial offsets as if client's entire buffer contains CRs
  let total_crs = 0;
  for (let p of patches) {
    p.start1 -= total_crs;
    p.start2 -= total_crs;
    for (let d of p.diffs) {
      const fixed = d[1].replace(CRRegex, "");
      const crs = d[1].length - fixed.length;
      if (crs === 0) {
        continue;
      }
      d[1] = fixed;
      total_crs += crs;
      switch (d[0]) {
        case -1:
          p.length2 += crs;
          break;
        case 0:
          p.length1 -= crs;
          p.length2 -= crs;
          break;
        case 1:
          p.length2 -= crs;
          break;
        default:
          log.error("BAD PATCH OMG");
          return [patch_text, null, null];
      }
    }
  }

  const old_patch_text = patch_text;
  patch_text = JS_DMP.patch_toText(patches);
  log.log("old patch:", old_patch_text);
  log.log("new patch:", patch_text);
  return [patch_text, null, null];
};

TextBuffer.prototype.normalize = function (state) {
  var self = this;

  if (!_.isString(state)) {
    state = state.toString(self.encoding);
  }
  state = state.replace(CRRegex, "");
  return new Buffer(state, self.encoding);
};


const BinaryBuffer = function () {
  var self = this;

  self.encoding = "base64";
  BaseBuffer.apply(self, arguments);
};

util.inherits(BinaryBuffer, BaseBuffer);

BinaryBuffer.prototype.get_content_type = function () {
  var self = this;
  return mime.contentType(self.get_extension()) || "application/octet-stream";
};

BinaryBuffer.prototype.apply_patches_to_buffer = function (patches, buf) {
  return DMP.patch_apply(patches, buf);
};

const make = function (room, id, path, text, md5, create, encoding) {
  var state = text;

  // Wow we actually take the time to validate this stuff.
  if (!_.isObject(room)) {
    throw new Error("Invalid workspace object passed to buffer make()");
  }
  if (id % 1 !== 0) {
    throw new Error("Buffer ID is not an integer.");
  }
  if (!_.isString(path) || path.length < 1) {
    throw new Error(util.format("Invalid path for buffer ID %s", id));
  }
  if (!_.isString(md5) || md5.length !== 32) {
    throw new Error(util.format("Invalid md5 for buffer ID %s", id));
  }

  if (encoding === "utf8") {
    return new TextBuffer(room, id, path, state, md5, create);
  }
  if (encoding === "base64") {
    return new BinaryBuffer(room, id, path, state, md5, create);
  }

  throw new Error(util.format("Unsupported encoding: '%s'", encoding));
};

const from_db = function (room, row) {
  return make(room, row.id, row.path, new Buffer(0), row.md5, false, row.encoding);
};

SUPPORTED_ENCODINGS = {
  base64: BinaryBuffer,
  utf8: TextBuffer
};

module.exports = {
  BaseBuffer,
  BinaryBuffer,
  DMP,
  from_db,
  JS_DMP,
  LOAD_STATES,
  LOAD_STATES_REVERSE,
  make,
  TextBuffer,
};
