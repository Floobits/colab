"use strict";

const events = require("events");
const path = require("path");
const url = require("url");
const util = require("util");

const _ = require("lodash");
const async = require("async");
const fleece = require("fleece");
const log = require("floorine");

const api_client = require("./api_client");
const ColabTerm = require("./term");
const ldb = require("./ldb");
const buffer = require("./buffer");
const MSG = require("./msg");
const perms = require("./perms");
const Repo = require("./repo");
const RoomEvent = require("./room_event");
const settings = require("./settings");
const solicit = require("./solicit");
const utils = require("./utils");
const actions = require("./actions");

const path_chunk_blacklist = [
  "",
  ".",
  ".."
];

const ROOM_STATES = {
  LOADING: 1,
  LOADED: 2,
  EVICTING: 3,
  DESTROYING: 4,
};
const STATES_REVERSE = _.invert(ROOM_STATES);

// Actions sent to everyone, including the client that sent the action
const BROADCAST_ACTIONS = [
  "create_buf",
  "delete_buf",
  "rename_buf",
  "create_term",
  "delete_term",
  "user_info",
  "perms",
];

// Event names that should be saved to DB and replayed
const PERSISTENT_EVENTS = [
  "join",
  "msg",
  "part",
  "solicit",
];


const Room = function (id, atts, server) {
  const self = this;

  self.id = id;
  self.handlers = {};
  self.bufs = {};
  // directory in json :)
  self.tree = {};

  self.cur_fid = 0;
  self.name = null;
  self.owner = null;
  self.max_size = settings.max_buf_len * 10;
  self.secret = null;
  self.created_at = 0;
  self.updated_at = 0;

  self.atts = null;
  if (atts) {
    self.set_atts(atts);
  }

  self.terms = {};
  self.cur_term_id = 0;

  self.msgs = [];
  self.events = [];
  self.part_event_ids = {};
  self.last_highlight = null;
  self.server = server;
  self.path = path.normalize(path.join(settings.bufs_dir, self.id.toString()));

  self.temp_data = {};
  self.anon_perms = [];
  self.version = 0;
  self.dirty = false;
  self.save_timeout = null;

  self.state = ROOM_STATES.LOADING;

  events.EventEmitter.call(self);
};

util.inherits(Room, events.EventEmitter);

Room.prototype.EXTRA_PERMS = {};

Room.prototype.set_atts = function (atts) {
  const self = this;

  if (self.atts) {
    return;
  }
  self.atts = atts;

  self.cur_fid = Math.max(atts.cur_fid || 0, self.cur_fid);
  self.name = atts.name;
  self.owner = atts.owner;
  self.max_size = atts.max_size || settings.max_buf_len * 20;
  self.secret = atts.secret;
  self.created_at = new Date(atts.created_at).getTime();
  self.updated_at = new Date(atts.updated_at).getTime();

  if (atts.repo_info && !_.isEmpty(atts.repo_info)) {
    self.repo = new Repo(self, atts.repo_info, atts.private_github_url);
  }
};

Room.prototype.load = function (agent, options) {
  const self = this;

  options = options || {};
  _.extend(options, { valueEncoding: "json" });

  actions.room.add(self);

  const auto = {};
  auto.levelup = function (cb) {
    ldb.get_db(null, self.id, options, cb);
  };
  auto.version = ["levelup", function (cb, response) {
    self.db = response.levelup;
    self.server.db.get(util.format("version_%s", self.id), cb);
  }];
  auto.loadEvents = ["version", function (cb) {
    self.loadEvents(cb);
  }];
  auto.loadBufs = ["version", function (cb, response) {
    self.version = parseInt(response.version, 10) || 0;
    log.debug("Initialized workspace", self.id, self.name, self.owner);
    self.loadBufs(agent, cb);
  }];

  async.auto(auto, function (err) {
    if (err) {
      err = err.toString();
      self.destroy();
    } else {
      utils.set_state(self, ROOM_STATES.LOADED);
    }
    self.emit("load", err);
  });
};

Room.prototype.destroy = function (cb) {
  const self = this;

  cb = cb || function () { return; };

  if (self.state >= ROOM_STATES.DESTROYING) {
    log.warn("Something called destroy for %s even though we're already destroying.", self.toString());
    cb();
    return;
  }
  log.log("Removing %s from in-memory workspaces.", self.toString());
  utils.set_state(self, ROOM_STATES.DESTROYING);

  function cleanup() {
    actions.room.update(self.id, self);
    actions.room.remove(self);
    // Remove circular reference so stuff gets GC'd
    _.each(self.bufs, function (buf) {
      buf.cleanup();
    });
    self.bufs = {};
    if (self.db) {
      ldb.finish_db(self.db, self.id);
      self.db = null;
    }
    cb();
  }

  if (self.dirty) {
    self.save(cleanup);
  } else {
    cleanup();
  }
};

Room.prototype.replay_events = function (agent, cb) {
  const self = this;
  // Replay messages since user joined this workspace
  const replay_event_id = self.part_event_ids[agent.username] || 0;
  _.each(self.events, function (evt) {
    if (evt.id > replay_event_id && evt.name === "msg") {
      agent.write(evt.name, null, evt.to_json());
    }
  });
  if (self.last_highlight) {
    agent.write("highlight", null, self.last_highlight);
  }
  cb();
};

Room.prototype.evict = function (reason, evict_cb) {
  const self = this;

  evict_cb = evict_cb || function () { return; };

  if (self.state >= ROOM_STATES.EVICTING) {
    log.warn("Something called destroy for %s even though we're already destroying.", self.toString());
    evict_cb();
    return;
  }

  log.warn("Evicting all occupants of", self.toString());
  utils.set_state(self, ROOM_STATES.EVICTING);

  async.each(_.values(self.handlers), function (agent, cb) {
    agent.disconnect(reason, function (err) {
      if (err) {
        log.error(err);
      }
      cb();
    });
  }, function () {
    log.log("Evicted everyone in %s", self.toString());
    self.destroy(evict_cb);
  });
};

Room.prototype.dirtify = function () {
  const self = this;
  if (self.dirty) {
    return;
  }
  self.dirty = true;
  if (self.save_timeout) {
    return;
  }
  const now = Date.now();
  let save_delay = settings.save_delay;
  if (now - self.updated_at > save_delay) {
    // Hasn't been saved to DB in a long time, so save now.
    save_delay = 1;
    log.log("Dirtify: %s hasn't been saved in a while. Saving next tick.", self.toString());
  }
  self.save_timeout = setTimeout(function () {
    if (!self.dirty) {
      log.debug("Not dirty anymore. All done.");
      self.save_timeout = null;
      return;
    }
    self.save(function (err) {
      if (err) {
        log.error("Error saving %s: %s", self.toString(), err);
      }
    });
  }, save_delay);
};

Room.prototype.loadEvents = function (cb) {
  const self = this;

  function finish(err) {
    self.events = self.events.sort(function (a, b) { return a.id - b.id; });
    self.events = self.events.slice(-1 * settings.max_events);
    // XXXX: Hack. Don't replay as much if we crashed in the mean time
    _.each(self.events, function (evt) {
      try {
        self.part_event_ids[evt.data.username] = evt.id;
      } catch (e) {
        log.error("Error setting part event for %s: %s", JSON.stringify(evt.to_db()), e);
      }
    });
    return cb(err);
  }

  ldb.read_events(self.db, self.id, function (read_events_err, rs) {
    if (read_events_err) {
      return finish(read_events_err);
    }
    rs.on("close", finish);
    rs.on("error", function (err, data) {
      // This is bad, but don't completely die if one buffer isn't parseable (although this is really bad)
      log.error("Error loading %s: %s", err, data);
    });
    rs.on("data", function (data) {
      let row = data.value;
      try {
        row = JSON.parse(row);
      } catch (e) {
        log.error("Error parsing %s: %s", data, e);
        return;
      }
      if (_.contains(PERSISTENT_EVENTS, row.name)) {
        let evt;
        try {
          evt = new RoomEvent(row);
        } catch (e) {
          // old, invalid event. nuke it
          self.db.del(data.key, function (err) {
            if (err) {
              log.error("ERROR DELETING", row.id);
            }
            log.warn("Deleted", row.id);
          });
          log.error("Error loading event %s %s: %s", row.id, row.name, e);
          return;
        }
        log.debug("loaded persistent event", evt.to_db());
        self.events.push(evt);
      }
    });
  });
};

Room.prototype.loadBufs = function (agent, cb) {
  const self = this;
  let to_delete = [];

  const finish = function (finish_err) {
    async.eachLimit(to_delete, 20, function (buf, delete_cb) {
      self.db.put(buf.db_key, {
        id: buf.id,
        path: buf.path,
        deleted: true,
        md5: buf.md5,
        encoding: buf.encoding
      }, {
        valueEncoding: "json"
      }, delete_cb);
    });
    if (finish_err) {
      log.error("Error getting buffers for %s in db %s: %s", self.id, self.path, finish_err);
      return cb(finish_err);
    }
    if (_.size(self.bufs) > 0) {
      let old_cb = cb;
      // I don't think this ever happens
      cb = function () {
        log.error("loadBufs finish called multiple times for %s", self.toString());
      };
      return old_cb();
    }
    function createReadme(readme_err) {
      let readme = settings.readme.text;
      log.log("No buffers in workspace %s. Creating README.", self.toString());
      if (readme_err) {
        readme = util.format("%s\n\n%s", readme_err.toString(), readme);
      }
      self.create_buf(agent, null, settings.readme.name, readme, "utf8", function (err, result) {
        self.readme_buf = result;
        return cb(err, result);
      });
    }

    if (self.repo) {
      log.warn("No buffers in workspace. %s Pulling from repo.", self.toString());
      return self.repo.update(agent, null, function (err, result) {
        if (err) {
          return createReadme(err);
        }
        return cb(err, result);
      });
    }
    return createReadme();
  };

  ldb.read_buf_info(self.db, self.id, function (buf_info_err, rs) {
    if (buf_info_err) {
      return finish(buf_info_err);
    }
    rs.on("close", finish);
    rs.on("error", function (rs_err, data) {
      // This is bad, but don't completely die if one buffer isn't parseable (although this is really bad)
      log.error("Error loading %s: %s", rs_err, data);
    });
    rs.on("data", function (data) {
      let row = data.value;
      try {
        row = JSON.parse(row);
      } catch (e) {
        log.error("Error parsing %s: %s", data, e);
        return;
      }

      self.cur_fid = Math.max(self.cur_fid, row.id);

      if (row.deleted) {
        log.debug("Buffer %s is deleted", row.id);
        return;
      }
      let buf;
      try {
        buf = buffer.from_db(self, row);
      } catch (e) {
        // TODO: bubble this error up somehow
        log.error("Error in creating buffer from db:", e);
        return;
      }

      try {
        self.check_path(buf.path);
      } catch (e) {
        log.error("Check path failed for %s: %s. Marking as deleted.", buf.toString(), e.toString());
        to_delete.push(buf);
        return;
      }

      self.bufs[buf.id] = buf;
      self.tree_add_buf(buf);

      if (buf.path === settings.readme.name) {
        log.debug("Found README buf %s", buf.path);
        self.readme_buf = buf;
      }

      if (!settings.preload_bufs || agent.name === "repclient") {
        // Don't preload all bufs if the initial client is for replication. it probably only wants a couple bufs
        return;
      }
      buf.load(function (err) {
        if (err) {
          // TODO: also bubble this up
          log.error("Error loading buffer %s: %s", buf.toString(), err);
          return;
        }
        log.debug("Loaded buffer %s", buf.toString());
      });
    });
  });
};

Room.prototype.toString = function () {
  const self = this;
  return util.format("%s %s/%s", self.id, self.owner, self.name);
};

Room.prototype.room_info = function () {
  const self = this;
  let room_info = {
    "anon_perms": self.anon_perms,
    "bufs": {},
    "created_at": self.created_at,
    "updated_at": self.updated_at,
    "max_size": self.max_size,
    "owner": self.owner,
    "repo_info": self.repo && self.repo.to_json(),
    "room_name": self.name,
    "secret": self.secret,
    "server_id": self.server.id,
    "temp_data": self.temp_data,
    "terms": {},
    "tree": self.tree,
    "users": {}
  };

  room_info = _.assign(room_info, self.to_master_json());
  // hide room id from users
  delete room_info.id;

  _.each(self.bufs, function (buf, id) {
    room_info.bufs[id] = buf.to_room_info();
  });
  _.each(self.terms, function (term, id) {
    room_info.terms[id] = term.to_json();
  });
  return room_info;
};

Room.prototype.to_master_json = function () {
  let users = {};
  _.each(this.handlers, function (handler, k) {
    if (handler.name === "repclient") {
      return;
    }
    users[k] = handler.to_json();
  });
  let active = _.size(users) > 0;
  let data = {
    active: active,
    id: this.id,
    version: this.version,
  };
  if (active) {
    data.users = users;
    data.name = this.name;
    data.owner = this.owner;
  }
  return data;
};

Room.prototype.broadcast = function (name, source, req_id, data, broadcast) {
  const self = this;

  broadcast = _.isUndefined(broadcast) ? _.contains(BROADCAST_ACTIONS, name) : broadcast;

  if (_.contains(PERSISTENT_EVENTS, name)) {
    // Hack to prevent replication from bumping workspace version, causing another replication
    if (!source || source.name === "repclient") {
      return self.version;
    }
    self.version++;
    self.dirtify();
    self.events.push(new RoomEvent(self.version, name, data));
    self.events = self.events.slice(-1 * settings.max_events);
    actions.room.update(self.id, self);
  }

  const source_id = source && source.id;
  _.each(self.handlers, function (agent, k) {
    if (!agent) {
      // TODO: if write fails for a client, disconnection logic fires and synchronously modifies self.handlers
      // work-around for now, but we should fix the root cause
      log.warn("No agent for handler id %s", k);
      return;
    }
    if (broadcast || source_id !== agent.id) {
      agent.write(name, source_id === agent.id ? req_id : null, data);
      return;
    }
    if (req_id) {
      agent.ack(req_id);
    }
  });
  return self.version;
};

Room.prototype.get_buf = function (id) {
  return this.bufs[id];
};

Room.prototype.get_buf_by_path = function (p) {
  const self = this;
  const buf = _.find(self.bufs, function (b) {
    return b.path === p;
  });
  return buf;
};

Room.prototype.bufs_size = function () {
  const self = this;

  let bufs_size = 0;
  _.each(self.bufs, function (buf) {
    if (buf._state) {
      bufs_size += buf._state.length;
    }
    // If the user is lucky enough to create a buffer before we're done loading, I guess it's not a huge deal
  });
  return bufs_size;
};

Room.prototype.check_path = function (_path) {
  const self = this;

  if (!_path || _path.length === 0) {
    throw new Error("Buffer path can't be empty. Byebye.");
  }
  if (_path[0] === "/") {
    throw new Error("Buffer path can't start with /. Byebye.");
  }
  if (_path[_path.length - 1] === "/") {
    throw new Error("Buffer path can't end with a /. Byebye.");
  }
  if (_path.search("//") > 0) {
    throw new Error("Buffer path can't have consecutive slashes in it.");
  }

  const dup_buf = self.get_buf_by_path(_path);
  if (dup_buf) {
    throw new Error("Duplicate path. Buffer " + dup_buf.id + " already has path " + _path);
  }

  let err;
  let tree = self.tree;
  _.each(_path.split("/"), function (chunk) {
    if (_.contains(path_chunk_blacklist, chunk)) {
      err = util.format("'%s' is not an allowed file or directory name", chunk);
      return false;
    }
    tree = tree[chunk] || {};
    // a numeric node means the node is a file ...
    if (_.isFinite(tree)) {
      err = util.format("%s conflicts with existing buffer.", _path);
      return false;
    }
  });

  if (err) {
    throw new Error(err);
  }
};

Room.prototype.create_buf = function (agent, req_id, buf_path, text, encoding, cb) {
  const self = this;

  if (cb === undefined) {
    cb = function () { return; };
  }
  log.debug("creating buf for path", buf_path);
  try {
    self.check_path(buf_path);
  } catch (e) {
    return cb(e.toString());
  }
  if (settings.max_buf_len && text.length > settings.max_buf_len) {
    return cb("Buffer is too big. Max buffer size is", settings.max_buf_len, "bytes.");
  }

  if (self.bufs_size() > self.max_size) {
    // TODO: tell the user how to increase the max size (pay monies)
    return cb(util.format("Sorry, you've hit this workspace's max size of %s bytes. Please delete some files from it before adding more.", self.max_size));
  }

  const fid = ++self.cur_fid;
  self.dirtify();

  if (self.get_buf(fid)) {
    return cb("create_buf: Buffer id " + fid + " already exists for buf " + self.get_buf(fid));
  }

  let buf;
  try {
    buf = buffer.make(self, fid, buf_path, text, utils.md5(text), true, encoding);
  } catch (ee) {
    log.error(ee);
    return cb("Couldn't create buffer containing binary data.");
  }
  self.bufs[buf.id] = buf;
  self.tree_add_buf(buf);

  // TODO: to_json(agent) doesn't do what we want
  let data;
  if (agent) {
    data = _.extend(buf.to_json(agent), {user_id: agent.id, username: agent.username});
  } else {
    data = buf.to_json();
  }
  self.broadcast("create_buf", agent, req_id, data);
  self.dirtify();
  // Only delete readme if it hasn't been modified
  if (self.readme_buf && self.readme_buf._state && self.readme_buf._state.toString(self.readme_buf.encoding) === settings.readme.text) {
    self.delete_buf(agent, req_id, self.readme_buf.id, true, function () { return; });
    self.readme_buf = null;
  }
  return cb(null, buf);
};

Room.prototype.delete_buf = function (agent, req_id, buf_id, unlink, cb) {
  const self = this;
  const buf = self.get_buf(buf_id);
  agent = agent || {};
  if (!buf) {
    return cb("buf does not exist");
  }

  if (_.isFunction(unlink)) {
    cb = unlink;
    unlink = false;
  }

  cb = cb || function () { return; };

  // Default to not deleting the local copy on clients. Just stop tracking it.
  unlink = !!unlink;

  log.debug("deleting buf", buf.toString());

  buf.cancel_timeouts();

  self.db.put(buf.db_key, {
    id: buf.id,
    path: buf.path,
    deleted: true,
    md5: buf.md5,
    encoding: buf.encoding
  }, {
    valueEncoding: "json"
  }, function (err, result) {
    if (err) {
      log.error("delete buf err: %s. result: %s", err, result);
      return cb(err, result);
    }
    log.debug("marked buf", buf.toString(), "as deleted. removing from tree");
    try {
      self.tree_delete_buf(buf.path);
    } catch (e) {
      log.error("Error deleting buf %s from tree: %s", buf.toString(), e);
    }
    delete self.bufs[buf_id];
    if (self.last_highlight && self.last_highlight.id === buf_id) {
      self.last_highlight = null;
    }
    self.broadcast("delete_buf", agent, req_id, {
      id: buf_id,
      user_id: agent.id,
      username: agent.username,
      path: buf.path,
      unlink: unlink
    });
    self.dirtify();
    return cb(null, buf);
  });
};

Room.prototype.tree_add_buf = function (buf) {
  const self = this;
  utils.tree_add_buf(self.tree, buf.path, buf.id);
};

Room.prototype.tree_delete_buf = function (buf_path) {
  const self = this;

  const chunks = buf_path.split("/");
  const file_name = chunks.slice(-1)[0];
  let sub_tree = self.tree;
  for (let i = 0; i < chunks.length - 1; i++) {
    sub_tree = sub_tree[chunks[i]];
  }
  delete sub_tree[file_name];
  if (chunks.length > 1 && _.size(sub_tree) === 0) {
    self.tree_delete_buf(chunks.slice(0, -1).join("/"));
  }
};

Room.prototype.rename_buf = function (agent, req_id, buf_id, new_path, cb) {
  const self = this;
  const buf = self.get_buf(buf_id);
  if (!buf) {
    return cb("buf does not exist");
  }
  const old_path = buf.path;
  log.debug("renaming buf", old_path, "to", new_path);

  try {
    self.check_path(new_path);
  } catch (e) {
    return cb(e.toString());
  }

  self.tree_delete_buf(buf.path);
  buf.path = new_path;
  self.tree_add_buf(buf);

  return buf.save(true, function (err) {
    agent = agent || {};
    self.broadcast("rename_buf", agent, req_id, {
      id: buf_id,
      old_path: old_path,
      path: buf.path,
      user_id: agent.id,
      username: agent.username
    });
    return cb(err, old_path);
  });
};

Room.prototype.buf_paths = function () {
  const self = this;
  let buf_paths = {};
  _.each(self.bufs, function (buf, p) {
    buf_paths[p] = {
      "md5": buf._md5
    };
  });
  return buf_paths;
};

Room.prototype.save = function (cb) {
  const self = this;

  cb = cb || function () { return; };
  if (self.dirty) {
    self.version++;
    // TODO: we're double-bumping version here sometimes. super-lame
    actions.room.update(self.id, self);
  }
  self.dirty = false;
  if (self.save_timeout) {
    clearTimeout(self.save_timeout);
    self.save_timeout = null;
  }
  const now = new Date();
  self.updated_at = now.getTime();

  self.server.db.put(util.format("version_%s", self.id), self.version, function (version_err) {
    if (version_err) {
      return cb(version_err);
    }

    let workspace_info = {
      cur_fid: self.cur_fid,
      updated_at: now,
    };
    if (self.atts) {
      workspace_info.repo_info = self.repo ? self.repo.to_private_json() : {};
      delete workspace_info.repo_info.private_github_url;
    }

    api_client.workspace_set(self.id, workspace_info, function (err, result) {
      if (err) {
        log.error("Error saving %s: %s", self.toString(), err);
      } else {
        log.log("Saved %s version %s", self.toString(), self.version);
      }
      cb(err, result);
    });
  });
};

Room.prototype.save_bufs = function (save_cb) {
  const self = this;

  if (self.state >= ROOM_STATES.DESTROYING) {
    log.warn("Something called destroy for %s even though we're in save_bufs.", self.toString());
    save_cb();
    return;
  }

  let errors = [];
  async.eachLimit(_.values(self.bufs), 20, function (buf, cb) {
    buf.save(false, function (err) {
      buf.cancel_timeouts();
      if (err) {
        log.error("failure to save buffer:", buf.id, err);
        errors.push(buf);
      }
      setImmediate(cb);
    });
  }, function (err) {
    self.save_events(function (save_events_err) {
      return save_cb(err || save_events_err || (errors.length > 0 && errors));
    });
  });
};

Room.prototype.save_events = function (cb) {
  const self = this;

  let batch;
  try {
    batch = self.db.batch();
  } catch (e) {
    return cb(util.format("Error creating db.batch in save_events: %s", e));
  }

  _.each(self.events, function (evt) {
    if (evt.name !== "msg") {
      return;
    }
    const key = util.format("event_%s", evt.id);
    batch.put(key, evt.to_db(), {
      valueEncoding: "json",
    });
    log.debug("Saving event %s", evt.toString());
  });
  batch.write(function (err) {
    return cb(err);
  });
};

Room.prototype.get_term = function (id) {
  const self = this;
  return self.terms[id];
};

Room.prototype.create_term = function (agent, name, size, term_id, cb) {
  const self = this;

  if (!name || name === "") {
    return cb("A name is required when creating a terminal.");
  }

  if (!name.match(/^[a-zA-Z0-9\-_]+$/)) {
    return cb("Terminal names can only contain letters, numbers, dashes and underscores.");
  }

  let term = _.find(self.terms, function (t) {
    return t.name === name;
  });

  if (!_.isArray(size)) {
    size = [100, 35];
  } else {
    size = size.slice(0, 2);
  }

  if (term) {
    return cb("A terminal with this name already exists.");
  }

  if (term_id) {
    term = self.terms[term_id];
    if (term && term.owner.user_id !== agent.user_id) {
      return cb(util.format("You don't own terminal id %s", term_id));
    }
  } else {
    term_id = ++self.cur_term_id;
    while (self.terms[term_id]) {
      term_id = ++self.cur_term_id;
    }
  }

  term = new ColabTerm(self, term_id, agent, name, size);
  self.terms[term_id] = term;

  self.broadcast("create_term", agent, null, term.to_json());
  return cb(null, term);
};

Room.prototype.delete_term = function (agent, req_id, id) {
  const self = this;
  delete self.terms[id];
  self.broadcast("delete_term", agent, req_id, {
    id: id,
    user_id: agent.id,
    username: agent.username
  });
};

Room.prototype.on_highlight = function (agent, req_id, req, cb) {
  const self = this;
  const ranges = req.ranges;
  log.debug("agent.js: agent", agent.id, "user", agent.username, "highlighted", ranges);

  if (!_.isArray(ranges)) {
    return cb(util.format("Can't highlight buffer %s: Ranges are not an array.", req.id));
  }
  if (ranges.length === 0) {
    return cb(util.format("Can't highlight buffer %s: Ranges are empty.", req.id));
  }
  if (!self.get_buf(req.id)) {
    return cb(util.format("Can't highlight buffer %s. It doesn't exist", req.id));
  }

  let valid_range = true;
  _.each(ranges, function (range) {
    log.debug("range:", range);
    if (range.length !== 2) {
      valid_range = false;
      return;
    }
    // Make sure ranges are in order so lame editors don't have to swap them
    if (range[0] > range[1]) {
      let temp = range[0];
      range[0] = range[1];
      range[1] = temp;
    }
  });
  if (!valid_range) {
    return cb(util.format("Can't highlight buffer %s: Ranges are not valid.", req.id));
  }

  const summon = !!req.ping || !!req.summon;
  const highlight = {
    id: req.id,
    user_id: agent.id,
    username: agent.username,
    ranges: ranges,
    ping: summon,
    summon: summon,
    following: !!req.following,
  };
  if (summon || !highlight.following) {
    self.last_highlight = highlight;
  }
  if (req.to) {
    _.each(self.handlers, function (a, k) {
      if (!a) {
        // TODO: if write fails for a client, disconnection logic fires and synchronously modifies self.handlers
        // work-around for now, but we should fix the root cause
        log.warn("No agent for handler id %s", k);
        return;
      }
      if (_.contains(req.to, a.username)) {
        agent.write("highlight", null, highlight);
      }
    });
  } else {
    self.broadcast("highlight", agent, null, highlight);
  }
  return cb(null, highlight);
};

Room.prototype.on_msg = function (agent, req_id, msg_string) {
  const self = this;
  const msg = new MSG(agent, msg_string);
  self.broadcast("msg", agent, req_id, msg.to_json());
  self.msgs.push(msg);
  self.msgs = self.msgs.slice(-20);

  const urls = msg_string.match(utils.url_regex);
  if (!urls) {
    return;
  }

  _.each(urls, function (msg_url) {
    fleece.describe_url(msg_url, function (err, result) {
      if (err) {
        log.warn("Floobot URL %s error: %s", msg_url, err);
        return;
      }
      if (!result) {
        log.log("Floobot URL %s: No result", msg_url);
        return;
      }
      let floobot_msg = new MSG({username: "floobot"}, "    \u001F" + result);
      // {} is used to get around squelching of messages in broadcast
      self.broadcast("msg", {}, null, floobot_msg.to_json(), true);
    });
  });
};

Room.prototype.on_datamsg = function (agent, req_id, msg) {
  const self = this;
  const data = {
    user_id: agent.id,
    data: msg.data,
  };
  if (_.size(msg.to) === 0) {
    self.broadcast("datamsg", agent, req_id, data);
    return;
  }

  _.each(msg.to, function (user_id) {
    const a = self.handlers[user_id];
    if (_.isUndefined(a)) {
      return;
    }
    a.write("datamsg", null, data);
  });
  if (req_id) {
    agent.ack(req_id);
  }
};

Room.prototype.on_webrtc = function (agent, req_id, data) {
  const self = this;

  data.user_id = agent.id;
  delete data.req_id;

  const patchActions = [
    "mute",
    "quit",
    "reject",
    "start",
    "stop",
    "unmute",
  ];

  if (!_.contains(agent.perms, "patch") && _.contains(patchActions, data.action)) {
    agent.error(req_id, util.format("You don't have permission to %s", data.action));
    return;
  }

  // disable/enable/don't change video_chatting indicator depending on webrtc event
  if (data.action !== "stop") {
    agent.video_chatting = !_.contains([
      "quit",
      "reject",
    ], data.action);
  }

  if (_.size(data.to) === 0) {
    // Nobody explicitly specified? Send to everyone.
    self.broadcast("webrtc", agent, req_id, data);
    return;
  }

  _.each(data.to, function (user_id) {
    const a = self.handlers[user_id];
    if (_.isUndefined(a)) {
      return;
    }
    a.write("webrtc", null, data);
  });
  if (req_id) {
    agent.ack(req_id);
  }
};

Room.prototype.part = function (agent) {
  const self = this;

  const event_id = self.broadcast("part", agent, null, {"user_id": agent.id, "username": agent.username});
  self.part_event_ids[agent.username] = event_id;

  if (self.temp_data.hangout) {
    const hangout_agents = _.find(self.handlers, function (handler) {
      return handler.client === "web-hangout";
    });
    if (_.isUndefined(hangout_agents)) {
      log.debug("No more hangout people in the workspace. Deleting hangout temp_data.");
      self.delete_temp_data(agent, null, ["hangout"]);
    }
  }

  _.each(self.terms, function (term, id) {
    if (term.owner !== agent) {
      return;
    }
    self.delete_term(agent, null, id);
  });

  delete self.handlers[agent.id];

  if (!_.isEmpty(self.handlers)) {
    return;
  }
  // TODO: this should live in destroy()
  self.save_bufs(function (err) {
    if (err) {
      log.error("Couldn't save buffers for workspace", self, ":", err);
    }
    if (!_.isEmpty(self.handlers)) {
      log.debug("Workspace is not empty. Not removing from in-memory workspaces. %s still connected.", _.size(self.handlers));
      return;
    }
    log.debug("Workspace %s is still empty. Removing from in-memory workspaces.", self.id);
    self.destroy();
  });
};

Room.prototype.set_temp_data = function (agent, data) {
  const self = this;

  // TODO: validate and stuff
  if (_.keys(data).length > 1) {
    log.debug("too many keys");
    return;
  }

  if (data.hangout && data.hangout.url) {
    const url_obj = url.parse(data.hangout.url);
    if (url_obj.protocol !== "https:" || !url_obj.hostname.match(/\.google\.com$/)) {
      log.debug("hangout url does not match");
      return;
    }
  } else if (data.webrtc && data.webrtc[agent.id]) {
    log.debug("webrtc:", data.webrtc);
  } else {
    log.log("Bad temp data", data);
    return;
  }

  let changed = false;
  _.each(data, function (v, k) {
    log.debug("comparing key", k, ":", self.temp_data[k], v);
    if (!_.isEqual(self.temp_data[k], v)) {
      changed = true;
      log.debug(k + " is changed");
    }
  });
  if (!changed) {
    return;
  }
  _.extend(self.temp_data, data);

  self.broadcast("set_temp_data", agent, null, {
    data: data,
    user_id: agent.id,
    username: agent.username
  });
};

Room.prototype.delete_temp_data = function (agent, req_id, data) {
  const self = this;

  // TODO: validate and stuff
  _.each(data, function (k) {
    delete self.temp_data[k];
  });
  self.broadcast("delete_temp_data", agent, req_id, {
    data: data,
    user_id: agent.id,
    username: agent.username
  });
};

Room.prototype.get_admins = function () {
  const self = this;

  return _.filter(self.handlers, function (user) {
    return _.contains(user.perms, "perms");
  });
};

Room.prototype.add_agent = function (agent, user, add_agent_cb) {
  const self = this;

  if (!settings.debug) {
    log.debug("This workspace requires SSL");
    if (!agent.is_ssl) {
      return add_agent_cb("This workspace requires SSL and you're on an unencrypted connection.");
    }
    log.debug("Agent", agent.toString(), "is on a secure connection.");
  }

  if (agent.name === "repclient") {
    // Short-circuit Django API calls and just give the repclient full access
    agent.perms = perms.all_perms;
    return add_agent_cb(null, self);
  }

  return async.parallel({
    anon_perms: function (cb) {
      api_client.perms_for_room("AnonymousUser", self.id, false, cb);
    },
    agent_perms: function (cb) {
      api_client.perms_for_room((agent.is_anon ? "AnonymousUser" : user.username), self.id, user.is_superuser, cb);
    }
  }, function (err, res) {
    if (err) {
      log.error("Error getting perms for %s: %s", agent.toString(), err);
      // TODO: The cb error is sent back to the user, but we want them to try and reconnect.
      return add_agent_cb(err);
    }
    self.anon_perms = perms.fine_grained_perms(res.anon_perms.perms);

    agent.perms = perms.fine_grained_perms(res.agent_perms.perms);
    if (agent.perms.length === 0) {
      return add_agent_cb("User doesn't have permission to join this workspace");
    }

    _.each(res.agent_perms, function (perm) {
      const extra_perms = self.EXTRA_PERMS[perm];
      if (extra_perms) {
        agent.perms.push.apply(agent.perms, extra_perms);
      }
    });

    // Logged-in users get message privileges
    // TODO: hacky and totally in the wrong place
    if (agent.is_anon === false && _.contains(res.agent_perms, "view_room")) {
      agent.perms.push("msg");
      agent.perms = _.uniq(agent.perms);
    }

    return add_agent_cb(null, self);
  });
};

Room.prototype.replay_solicitations = function (agent, replay_cb) {
  const self = this;

  // Don't fetch solicitations if user is anon or we're in chat
  if (agent.is_anon || !self.name) {
    return replay_cb();
  }

  const auto = {
    get_solicitations: function (cb) {
      api_client.solicitations_get(self.owner, self.name, function (err, result) {
        if (err) {
          log.error("Error getting solicitations for %s: %s", agent.toString(), err);
          return cb();
        }
        return cb(null, result);
      });
    },
    replay_solicitations: ["get_solicitations", function (cb, result) {
      if (_.isEmpty(result.get_solicitations)) {
        return cb();
      }

      const data = _.reduce(result.get_solicitations, function (s, a) {
        if (s.updated_at > a.updated_at) {
          return s;
        }
        // TODO: update s to keep this list from growing
        return a;
      }, {updated_at: 0});

      let solicitation;
      try {
        solicitation = new solicit.Solicitation(data);
      } catch (e) {
        log.error("Error building Solicitation from json:", e);
        return cb();
      }
      solicitation.stop_update_timeout();
      // Only tell Pro room about potential contractors who joined
      const contractor = solicitation.contractors[agent.username];
      const id = solicitation.id;
      const s = solicitation.to_json();

      agent.write("solicit", null, {
        "data": s,
      });

      if (agent.can_contract && contractor && contractor.selected) {
        agent.perms.push("solicit");
        agent.perms = _.uniq(agent.perms);
        self.broadcast("perms", agent, null, {
          "action": "add",
          "user_id": agent.id,
          "perms": ["solicit"],
        });
        // TODO: bubble up errors?
        self.solicit(agent, null, {
          action: "join",
          data: {
            id: id,
          }
        }, function (err, res) {
          if (err) {
            log.error("ERROR in join broadcast after solicitation:", err, res);
          }
        });
      }
      return cb();
    }],
  };
  async.auto(auto, replay_cb);
};

Room.prototype.solicit = function (agent, req_id, req, cb) {
  const self = this;
  cb = cb || function (err) {
    if (err) {
      log.error("Room solicit error: %s. Req: %s", err, JSON.stringify(req));
    }
  };
  req.username = agent.username;
  req.path = util.format("%s/%s", this.owner, this.name);

  log.log("Solicitation %s", agent.toString(), JSON.stringify(req));
  actions.broadcast.solicit(this, req, function (err, res) {
    cb(err, res);
    if (err || req.action !== "hire" || !req.data) {
      return;
    }

    const pro = _.find(self.handlers, function (handler) {
      return handler.username === req.data.username;
    });

    if (!pro) {
      return;
    }
    // Pro is already in the workspace. Fake a join event
    pro.perms.push("solicit");
    pro.perms = _.uniq(pro.perms);
    self.broadcast("perms", pro, null, {
      "action": "add",
      "user_id": pro.id,
      "perms": ["solicit"],
    });
    self.solicit(pro, null, {
      action: "join",
      data: {
        id: req.data.id,
      }
    });
  });
};

const ProRoom = function () {
  Room.apply(this, arguments);
  this.solicitations = {};
  this.outstanding_reqs = {};
  // TODO: possible race condition if this takes a while. maybe we should put it in room load?
  this.once("load", this.poll_for_solicitations.bind(this));
};

util.inherits(ProRoom, Room);

ProRoom.prototype.poll_for_solicitations = function() {
  const self = this;
  self.load_solicitations(0, function (err, lastCreationTime) {
    if (err) {
      log.error(err);
    }
    lastCreationTime = lastCreationTime || 0;
    self.timer = setInterval(function () {
      self.load_solicitations(lastCreationTime, function (err, newlastCreationTime) {
        if (err) {
          log.error(err);
          return;
        }
        if (newlastCreationTime) {
          log.log("last time of Solicitation creation", newlastCreationTime);
          lastCreationTime = newlastCreationTime;
        }
      });
    }, 30 * 1000);
  });
};

ProRoom.prototype.destroy = function (cb) {
  clearTimeout(this.timer);
  Room.prototype.destroy.call(this, cb);
};

ProRoom.prototype.EXTRA_PERMS = {
  "edit_room": ["solicit"],
};

ProRoom.prototype.replay_solicitations = function (agent, cb) {
  _.each(this.solicitations, function (s) {
    agent.request("solicit", {data: s.to_json()});
  });
  return cb();
};

ProRoom.prototype.load_solicitations = function (since, cb) {
  const self = this;
  api_client.solicitations_get_active(since, function (err, result) {
    if (err) {
      log.error(err);
      return cb(err);
    }
    _.each(result, function (data) {
      if (self.solicitations[data.id]) {
        return;
      }
      const s = new solicit.Solicitation(data);

      log.log("Loaded active solicitation %s", s.toString());

      self.solicitations[data.id] = s;
      const broadcast_data = {
        data: s.to_json(),
        name: "solicit",
        action: "create",
      };
      actions.broadcast.send_to_path(util.format("%s/%s", self.owner, self.name), s.path, broadcast_data, function (broadcast_err) {
        if (broadcast_err) {
          log.error(broadcast_err);
        }
      });
      self.broadcast("solicit", null, null, broadcast_data);
      since = Math.max(since, s.created_at / 1000);
    });
    return cb(null, since);
  });
};

ProRoom.prototype.on_solicit = function (agent, req, cb) {
  this.solicit(agent, req.req_id, req, cb);
};

ProRoom.prototype.solicit = function (agent, req_id, req, cb) {
  const self = this;
  const data = req.data;
  const action = req.action;
  let s = self.solicitations[data.id];

  // Lame hack to stop js client from ruining everything
  delete data.contractor;
  delete data.contractors;
  if (action === "create") {
    if (s) {
      return cb(util.format("A solicitation with ID %s already exists.", data.id));
    }
    data.username = agent.username;
    s = new solicit.Solicitation(data);
  }

  if (!s) {
    if (action === "keep_alive") {
      // TODO: change error handling in the client so we can tell them about this without a modal
      return cb();
    }
    return cb(util.format("No solicitation with ID %s.", data.id));
  }

  const f = s[util.format("on_%s", action)];
  if (!_.isFunction(f)) {
    return cb("Unknown action.");
  }
  f.call(s, agent, data, function (err, result) {
    if (err) {
      log.error("Error in solicitation action %s: %s. Data: %s", req.action, err, JSON.stringify(data, null, "  "));
      return cb(err);
    }
    const broadcast_data = {
      action: req.action,
      data: s.to_json(),
      name: "solicit",
    };
    switch (req.action) {
      case "create":
        self.solicitations[s.id] = s;
        break;
      case "absolve":
      case "cancel":
        delete self.solicitations[s.id];
        break;
      case "bid":
      case "feedback":
        // TODO: allow feedback from contractors
      case "complete":
        // TODO: prune completed
      case "hire":
        break;
      case "keep_alive":
        return cb(null, broadcast_data);
      case "join":
        // These events come from colabs, not clients
        // they are sent whenever a Pro joins any room
        // we mostly want to ignore them
        if (!result) {
          return cb(null, broadcast_data);
        }
        break;
      default:
        return cb("Unknown action " + req.action);
    }
    actions.broadcast.send_to_path(util.format("%s/%s", self.owner, self.name), s.path, broadcast_data, function (broadcast_err) {
      if (broadcast_err) {
        agent.error(req_id, broadcast_err);
      }
    });
    self.broadcast(req.name, agent, null, broadcast_data);
    return cb(null, broadcast_data);
  });
};

module.exports = {
  Room,
  ProRoom,
  STATES: ROOM_STATES,
  STATES_REVERSE,
};
