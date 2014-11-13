/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var events = require("events");
var path = require("path");
var url = require("url");
var util = require("util");

var _ = require("lodash");
var async = require("async");
var fs = require("fs-extra");
var log = require("floorine");

var api_client = require("./api_client");
var ColabTerm = require("./term");
var ldb = require("./ldb");
var make_buffer = require("./buffer").make_buffer;
var MSG = require("./msg");
var perms = require("./perms");
var Repo = require("./repo");
var RoomEvent = require("./room_event");
var settings = require("./settings");
var solicit = require("./solicit");
var utils = require("./utils");

var path_chunk_blacklist = [
  "",
  ".",
  ".."
];

var ROOM_STATES = {
  LOADING: 1,
  LOADED: 2,
  DESTROYING: 3
};

// Actions sent to everyone, including the client that sent the action
var BROADCAST_ACTIONS = [
  "create_buf",
  "delete_buf",
  "rename_buf",
  "create_term",
  "delete_term",
  "user_info",
  "perms"
];

// Event names that should be saved to DB and replayed
var PERSISTENT_EVENTS = [
  "msg",
  "part"
];


var Room = function (id, name, owner, atts, server) {
  var self = this;

  self.id = id;
  self.name = name;
  self.owner = owner;
  self.agents = {};
  self.bufs = {};
  // directory in json :)
  self.tree = {};
  self.cur_fid = atts.cur_fid || 0;

  self.max_size = atts.max_size;
  self.secret = atts.secret;
  self.created_at = new Date(atts.created_at).getTime();
  self.updated_at = new Date(atts.updated_at).getTime();

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

  if (atts.repo_info && !_.isEmpty(atts.repo_info)) {
    self.repo = new Repo(self, atts.repo_info);
  }
  events.EventEmitter.call(self);
};

util.inherits(Room, events.EventEmitter);

Room.prototype.EXTRA_PERMS = {};

Room.prototype.load = function (agent) {
  var self = this,
    auto = {};

  self.server.workspaces[self.id] = self;

  auto.levelup = function (cb) {
    ldb.get_db(null, self.id, { valueEncoding: "json" }, cb);
  };
  auto.version = ["levelup", function (cb, response) {
    self.db = response.levelup;
    self.server.db.get(util.format("version_%s", self.id), cb);
  }];
  auto.loadEvents = ["version", function (cb) {
    self.loadEvents(cb);
  }];
  auto.loadBufs = ["version", function (cb, response) {
    self.version = response.version || 0;
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

Room.prototype.destroy = function () {
  var self = this;

  if (self.state >= ROOM_STATES.DESTROYING) {
    log.warn("Something called destroy for %s even though we're already destroying.", self.toString());
    return;
  }
  log.log("Removing %s from in-memory workspaces.", self.toString());
  utils.set_state(self, ROOM_STATES.DESTROYING);

  function cleanup() {
    delete self.server.workspaces[self.id];
    if (self.db) {
      ldb.finish_db(self.db, self.id);
    }
  }

  if (self.dirty) {
    self.save(cleanup);
  } else {
    cleanup();
  }
};

Room.prototype.dirtify = function () {
  var self = this,
    now,
    save_delay = settings.save_delay;
  if (self.dirty) {
    return;
  }
  self.dirty = true;
  if (self.save_timeout) {
    return;
  }
  now = Date.now();
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
  var self = this;

  function finish(err) {
    self.events = self.events.slice(-1 * settings.max_events);
    return cb(err);
  }

  ldb.read_events(self.db, self.id, function (err, rs) {
    if (err) {
      return finish(err);
    }
    rs.on("close", finish);
    rs.on("error", function (err, data) {
      // This is bad, but don't completely die if one buffer isn't parseable (although this is really bad)
      log.error("Error loading %s: %s", err, data);
    });
    rs.on("data", function (data) {
      var row = data.value,
        evt;
      try {
        row = JSON.parse(row);
      } catch (e) {
        log.error("Error parsing %s: %s", data, e);
        return;
      }
      if (_.contains(PERSISTENT_EVENTS, row.name)) {
        evt = new RoomEvent(row);
        self.events.push(evt);
        if (evt.name === "part") {
          try {
            self.part_event_ids[evt.data.username] = evt.id;
          } catch (e) {
            log.error("Error setting part event for %s: %s", JSON.stringify(evt.to_json()), e);
          }
        }
      }
    });
  });
};

Room.prototype.loadBufs = function (agent, cb) {
  var self = this,
    finish,
    to_delete = [];

  finish = function (err) {
    async.eachLimit(to_delete, 20, function (buf, cb) {
      self.db.put(buf.db_key, {
        id: buf.id,
        path: buf.path,
        deleted: true,
        md5: buf.md5,
        encoding: buf.encoding
      }, {
        valueEncoding: "json"
      }, cb);
    });
    if (err) {
      log.error("Error getting buffers for %s in db %s: %s", self.id, self.path, err);
      cb(err);
      return;
    }
    if (_.size(self.bufs) > 0) {
      cb();
      cb = function () {
        log.error("loadRoom finish called multiple times for %s", self.toString());
      };
      return;
    }
    var createReadme = function (err) {
      var readme = settings.readme.text;
      log.log("No buffers in workspace %s. Creating README.", self.toString());
      if (err) {
        readme = util.format("%s\n\n%s", err.toString(), readme);
      }
      self.create_buf(agent, null, settings.readme.name, readme, "utf8", function (err, result) {
        self.readme_buf = result;
        return cb(err, result);
      });
    };

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

  ldb.read_buf_info(self.db, self.id, function (err, rs) {
    if (err) {
      return finish(err);
    }
    rs.on("close", finish);
    rs.on("error", function (err, data) {
      // This is bad, but don't completely die if one buffer isn't parseable (although this is really bad)
      log.error("Error loading %s: %s", err, data);
    });
    rs.on("data", function (data) {
      var buf,
        row = data.value;
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
      try {
        buf = make_buffer(self, row.id, row.path, new Buffer(0), row.md5, false, row.encoding);
      } catch (e) {
        // TODO: bubble this error up somehow
        log.error("Error in make_buffer:", e);
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
      buf.load(function (err) {
        if (err) {
          // TODO: also bubble this up
          log.error("Error loading buffer %s: %s", buf.toString(), err);
          return;
        }
        log.debug("Loaded buffer %s", buf.toString());
        if (buf.path === settings.readme.name) {
          log.debug("Found README buf %s", buf.path);
          self.readme_buf = buf;
        }
      });
    });
  });
};

Room.prototype.toString = function () {
  var self = this;
  return util.format("%s %s/%s", self.id, self.owner, self.name);
};

Room.prototype.to_json = function (agent) {
  var self = this,
    room_info = {
      "anon_perms": self.anon_perms,
      "bufs": {},
      "created_at": self.created_at,
      "updated_at": self.updated_at,
      "max_size": self.max_size,
      "owner": self.owner,
      "room_name": self.name,
      "secret": self.secret,
      "server_id": self.server.id,
      "temp_data": self.temp_data,
      "terms": {},
      "tree": self.tree,
      "users": {}
    };

  _.each(self.agents, function (a, id) {
    if (agent && agent.version <= 0.02) {
      room_info.users[id] = a.username;
    } else {
      room_info.users[id] = a.to_json();
    }
  });
  _.each(self.bufs, function (buf, id) {
    room_info.bufs[id] = buf.to_room_info();
  });
  _.each(self.terms, function (term, id) {
    room_info.terms[id] = term.to_json();
  });
  return room_info;
};

Room.prototype.broadcast = function (name, source, req_id, data) {
  var self = this,
    source_id = source && source.id,
    broadcast = _.contains(BROADCAST_ACTIONS, name);

  if (_.contains(PERSISTENT_EVENTS, name)) {
    self.version++;
    self.dirtify();
    self.events.push(new RoomEvent(self.version, name, data));
    self.events = self.events.slice(-1 * settings.max_events);
  }

  _.each(self.agents, function (agent) {
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

Room.prototype.get_buf_by_path = function (path) {
  var self = this,
    buf;
  buf = _.find(self.bufs, function (buf) {
    return buf.path === path;
  });
  return buf;
};

Room.prototype.bufs_size = function () {
  var self = this,
    bufs_size = 0;

  _.each(self.bufs, function (buf) {
    if (buf._state) {
      bufs_size += buf._state.length;
    }
    // If the user is lucky enough to create a buffer before we're done loading, I guess it's not a huge deal
  });
  return bufs_size;
};

Room.prototype.check_path = function (_path) {
  var self = this,
    dup_buf,
    err;

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

  _.each(_path.split("/"), function (chunk) {
    if (_.contains(path_chunk_blacklist, chunk)) {
      err = '"' + chunk + '" is not an allowed file or directory name';
    }
  });

  if (err) {
    throw new Error(err);
  }

  dup_buf = self.get_buf_by_path(_path);
  if (dup_buf) {
    throw new Error("Duplicate path. Buffer " + dup_buf.id + " already has path " + _path);
  }
};

Room.prototype.create_buf = function (agent, req_id, path, text, encoding, cb) {
  var self = this,
    buf,
    data,
    fid;

  if (cb === undefined) {
    cb = function () { return; };
  }
  log.debug("creating buf for path", path);
  try {
    self.check_path(path);
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

  fid = ++self.cur_fid;
  self.dirtify();

  if (self.get_buf(fid)) {
    return cb("create_buf: Buffer id " + fid + " already exists for buf " + self.get_buf(fid));
  }

  try {
    buf = make_buffer(self, fid, path, text, undefined, true, encoding);
  } catch (ee) {
    log.error(ee);
    return cb("Couldn't create buffer containing binary data.");
  }
  self.bufs[buf.id] = buf;
  self.tree_add_buf(buf);

  // TODO: to_json(agent) doesn't do what we want
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
  var self = this,
    buf = self.get_buf(buf_id);
  agent = agent || {};
  if (!buf) {
    return cb("buf does not exist");
  }

  if (_.isFunction(unlink)) {
    cb = unlink;
    unlink = false;
  }

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
  var self = this,
    chunk,
    chunks = buf.path.split("/"),
    file_name = chunks.slice(-1)[0],
    i,
    sub_tree = self.tree;

  // GOOD INTERVIEW QUESTION
  for (i = 0; i < chunks.length; i++) {
    chunk = chunks[i];
    if (i === chunks.length - 1 && sub_tree[chunk] !== undefined) {
      log.warn("trying to stomp path", buf.path);
      return;
    }
    sub_tree = sub_tree[chunk];
    if (sub_tree === undefined) {
      break;
    }
  }

  sub_tree = self.tree;
  _.each(chunks, function (chunk, pos) {
    if (!sub_tree[chunk]) {
      sub_tree[chunk] = {};
    }
    if (pos < chunks.length - 1) {
      sub_tree = sub_tree[chunk];
    }
  });
  sub_tree[file_name] = buf.id;
};

Room.prototype.tree_delete_buf = function (buf_path) {
  var self = this,
    chunks = buf_path.split("/"),
    file_name = chunks.slice(-1)[0],
    i,
    sub_tree = self.tree;

  for (i = 0; i < chunks.length - 1; i++) {
    sub_tree = sub_tree[chunks[i]];
  }
  delete sub_tree[file_name];
  if (chunks.length > 1 && _.size(sub_tree) === 0) {
    self.tree_delete_buf(chunks.slice(0, -1).join("/"));
  }
};

Room.prototype.rename_buf = function (agent, req_id, buf_id, new_path, cb) {
  var self = this,
    buf = self.get_buf(buf_id),
    old_path;

  agent = agent || {};
  if (!buf) {
    return cb("buf does not exist");
  }
  old_path = buf.path;
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
  var self = this,
    buf_paths = {};

  _.each(self.bufs, function (buf, path) {
    buf_paths[path] = {
      "md5": buf._md5
    };
  });
  return buf_paths;
};

Room.prototype.save = function (cb) {
  var self = this,
    now = new Date(),
    repo_json;

  cb = cb || function () { return; };
  if (self.dirty) {
    self.version++;
  }
  self.dirty = false;
  if (self.save_timeout) {
    clearTimeout(self.save_timeout);
    self.save_timeout = null;
  }
  self.updated_at = now.getTime();

  repo_json = self.repo ? self.repo.to_json() : {};
  self.server.db.put(util.format("version_%s", self.id), self.version, function (err) {
    var workspace_info = {
      cur_fid: self.cur_fid,
      updated_at: now,
      repo_info: repo_json,
    };

    if (err) {
      return cb(err);
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

Room.prototype.save_bufs = function (cb) {
  var self = this,
    errors = [];

  async.eachLimit(_.values(self.bufs), 20, function (buf, cb) {
    buf.save(false, function (err) {
      buf.cancel_timeouts();
      if (err) {
        log.error("failure to save buffer:", buf.guid, err);
        errors.push(buf);
      }
      setImmediate(cb);
    });
  }, function (err) {
    self.save_events(function (save_events_err) {
      return cb(err || save_events_err || (errors.length > 0 && errors));
    });
  });
};

Room.prototype.save_events = function (cb) {
  var self = this,
    batch;

  try {
    batch = self.db.batch();
  } catch (e) {
    return cb(util.format("Error creating db.batch in save_events: %s", e));
  }

  _.each(self.events, function (evt) {
    var key;
    if (evt.name !== "msg") {
      return;
    }
    key = util.format("event_%s", evt.id);
    batch.put(key, JSON.stringify(evt.to_json()));
  });
  batch.write(function (err) {
    return cb(err);
  });
};

Room.prototype.get_term = function (id) {
  var self = this;
  return self.terms[id];
};

Room.prototype.create_term = function (agent, name, size, term_id, cb) {
  var self = this,
    term;

  if (!name || name === "") {
    return cb("A name is required when creating a terminal.");
  }

  if (!name.match(/^[a-zA-Z0-9\-_]+$/)) {
    return cb("Terminal names can only contain letters, numbers, dashes and underscores.");
  }

  term = _.find(self.terms, function (term) {
    return term.name === name;
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
  var self = this;

  delete self.terms[id];
  self.broadcast("delete_term", agent, req_id, {
    id: id,
    user_id: agent.id,
    username: agent.username
  });
};

Room.prototype.on_msg = function (agent, req_id, msg_string) {
  var self = this,
    msg = new MSG(agent, msg_string);

  self.broadcast("msg", agent, req_id, msg.to_json());
  self.msgs.push(msg);
  self.msgs = self.msgs.slice(-20);
};

Room.prototype.on_datamsg = function (agent, req_id, msg) {
  var self = this,
    data = {
      user_id: agent.id,
      data: msg.data
    };

  if (_.size(msg.to) === 0) {
    self.broadcast("datamsg", agent, req_id, data);
    return;
  }

  _.each(msg.to, function (user_id) {
    var a = self.agents[user_id];
    if (_.isUndefined(a)) {
      return;
    }
    a.write("datamsg", null, data);
  });
  if (req_id) {
    agent.ack(req_id);
  }
};

Room.prototype.evict = function (reason, cb) {
  var self = this,
    auto = {};

  cb = cb || function () { return; };
  utils.set_state(self, ROOM_STATES.DESTROYING);

  log.warn("Evicting all occupants of", self.toString());

  auto.save_bufs = function (cb) {
    self.save_bufs(cb);
  };

  auto.cleanup_saves = ["save_bufs", function (cb) {
    self.save = function (cb) { return cb(); };
    _.each(self.bufs, function (buf) {
      buf.cancel_timeouts();
      buf.save = function () { return; };
    });
    return cb();
  }];

  auto.disconnect = ["cleanup_saves", function (cb) {
    async.forEach(_.values(self.agents), function (agent, cb) {
      try {
        agent.disconnect(reason, cb);
      } catch (e) {
        log.error("Couldn't disconnect agent", agent.id, e);
        cb(e);
      }
    }, cb);
  }];

  async.auto(auto, function (err, result) {
    log.log("Evicted everyone in %s", self.toString());
    self.save(function (save_err) {
      delete self.server.workspaces[self.id];
      return cb(err || save_err, result);
    });
  });
};

Room.prototype.part = function (agent) {
  var self = this,
    event_id,
    hangout_agents;

  event_id = self.broadcast("part", agent, null, {"user_id": agent.id, "username": agent.username});
  self.part_event_ids[agent.username] = event_id;

  if (self.temp_data.hangout) {
    hangout_agents = _.find(self.agents, function (agent) {
      return agent.client === "web-hangout";
    });
    if (_.isUndefined(hangout_agents)) {
      log.debug("No more hangout people in the workspace. Deleting hangout temp_data.");
      self.delete_temp_data(agent, null, ["hangout"]);
    }
  }

  delete self.agents[agent.id];

  if (!_.isEmpty(self.agents)) {
    return;
  }
  self.save_bufs(function (err) {
    if (err) {
      log.error("Couldn't save buffers for workspace", self, ":", err);
    }
    if (!_.isEmpty(self.agents)) {
      log.debug("Workspace is not empty. Not removing from in-memory workspaces. %s still connected.", _.size(self.agents));
      return;
    }
    log.debug("Workspace %s is still empty. Removing from in-memory workspaces.", self.id);
    self.destroy();
  });
};

Room.prototype.set_temp_data = function (agent, data) {
  var self = this,
    changed = false,
    url_obj;

  // TODO: validate and stuff
  if (_.keys(data).length > 1) {
    log.debug("too many keys");
    return;
  }

  if (data.hangout && data.hangout.url) {
    url_obj = url.parse(data.hangout.url);
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
  var self = this;

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
  var self = this;

  return _.filter(self.agents, function (user) {
    return _.contains(user.perms, "perms");
  });
};


var ProRoom = function () {
  this.solicitations = {};
  Room.apply(this, arguments);
};

util.inherits(ProRoom, Room);

ProRoom.prototype.EXTRA_PERMS = {
  "edit_room": ["create_solicit", "accept_solicit", "delete_solicit", "finish_solicit"],
};

ProRoom.prototype.create_solicit = function (agent, req_id, req) {
  var self = this,
    s;

  if (self.solicitations[req.id]) {
    return agent.error(req_id, util.format("A solicitation with ID %s already exists.", req.id));
  }

  s = new solicit.Solicitation(agent, req);
  self.solicitations[req.id] = s;

  self.broadcast("create_solicit", agent, req_id, s.to_json());
};

ProRoom.prototype.accept_solicit = function (agent, req_id, req) {
  var self = this,
    s = self.solicitations[req.id];

  if (!s) {
    return agent.error(req_id, util.format("No solicitation with ID %s.", req.id));
  }

  //TODO
};


exports.Room = Room;
exports.STATES = ROOM_STATES;

var finish_add_agent = function (err, agent, user, room, cb) {
  if (err) {
    log.error(err);
    return cb(err);
  }

  if (!settings.debug) {
    log.debug("This workspace requires SSL");
    if (!agent.is_ssl) {
      return cb("This workspace requires SSL and you're on an unencrypted connection.");
    }
    log.debug("Agent", agent.toString(), "is on a secure connection.");
  }

  return async.parallel({
    anon_perms: function (cb) {
      api_client.perms_for_room(-1, room.id, false, cb);
    },
    agent_perms: function (cb) {
      api_client.perms_for_room(user.id, room.id, user.is_superuser, cb);
    }
  }, function (err, res) {
    if (err) {
      log.error("Error getting perms for %s: %s", agent.toString(), err);
      // The cb error is sent back to the user, but we want them to try and reconnect.
      return cb();
    }
    room.anon_perms = perms.fine_grained_perms(res.anon_perms);

    agent.perms = perms.fine_grained_perms(res.agent_perms);
    if (agent.perms.length === 0) {
      return cb("user doesn't have permissions");
    }

    _.each(res.agent_perms, function (perm) {
      var extra_perms = room.EXTRA_PERMS[perm];
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

    return cb(undefined, room);
  });
};

exports.add_agent = function (room_path, agent, user, cb) {
  var finish,
    name,
    owner,
    path_parts = room_path.split("/"),
    room,
    server = agent.server;

  finish = function (err) {
    finish_add_agent(err, agent, user, room, cb);
  };

  if (path_parts.length === 1) {
    owner = path_parts[0];
    name = "";
  } else if (path_parts.length === 2) {
    owner = path_parts[0];
    name = path_parts[1];
  } else {
    return cb("Invalid path");
  }

  log.log("Adding agent %s for workspace %s owned by %s", agent.toString(), name, owner);
  api_client.workspace_get(owner, name, function (err, result) {
    var RoomClass = Room,
      db_room;
    if (err) {
      return finish(err);
    }

    log.log("Found workspace", result.id);
    log.debug("workspace_get response: %s", JSON.stringify(result));
    db_room = result;

    if (db_room === undefined) {
      log.error("Workspace id not found for", owner, name);
      return finish("Workspace not found");
    }

    room = server.workspaces[db_room.id];
    if (room) {
      if (room.state === ROOM_STATES.LOADING) {
        return room.once("load", finish);
      }
      if (room.state === ROOM_STATES.LOADED) {
        // In case it was updated
        room.max_size = db_room.max_size;
        return finish();
      }
      if (room.state === ROOM_STATES.DESTROYING) {
        return finish("No new users are allowed in this workspace. It is probably being deleted.");
      }
      return finish(util.format("Error in workspace state! State is %s", room.state));
    }
    if (db_room.pro) {
      RoomClass = ProRoom;
    }
    room = new RoomClass(db_room.id,
      db_room.name,
      owner, {
        cur_fid: db_room.cur_fid,
        max_size: db_room.max_size,
        secret: db_room.secret,
        repo_info: db_room.repo_info,
        created_at: db_room.created_at,
        updated_at: db_room.updated_at,
      },
      server);

    server.workspaces[db_room.id] = room;
    room.once("load", finish);
    room.load(agent);
  });
};
