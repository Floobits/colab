var events = require("events");
var path = require("path");
var url = require("url");
var util = require("util");

var _ = require("lodash");
var async = require("async");
var fs = require("fs-extra");
var log = require("floorine");

var make_buffer = require("./buffer").make_buffer;
var cache = require("./cache");
var ColabTerm = require("./term");
var db = require("./db");
var ldb = require("./ldb");
var MSG = require("./msg");
var settings = require("./settings");
var Repo = require("./repo");
var perms = require("./perms");
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

  self.terms = {};
  self.cur_term_id = 0;

  self.msgs = [];
  self.last_highlight = null;
  self.require_ssl = atts.require_ssl;
  self.max_size = atts.max_size;
  self.secret = atts.secret;
  self.server = server;
  self.path = path.normalize(path.join(settings.bufs_dir, self.id.toString()));

  self.temp_data = {};
  self.anon_perms = [];
  self.version = 0;
  self.dirty = false;

  self.state = ROOM_STATES.LOADING;

  if (atts.repo_info && !_.isEmpty(atts.repo_info)) {
    self.repo = new Repo(self, atts.repo_info);
  }
  events.EventEmitter.call(self);
};

util.inherits(Room, events.EventEmitter);

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
  auto.loadBufs = ["version", function (cb, response) {
    self.version = response.version;
    log.debug("Initialized workspace", self.id, self.name, self.owner);
    self.loadBufs(agent, cb);
  }];

  async.auto(auto, function (err) {
    if (err) {
      err = err.toString();
      self.destroy();
    } else {
      self.state = ROOM_STATES.LOADED;
      self.server.update_active_workspaces();
    }
    self.emit("load", err);
  });
};

Room.prototype.destroy = function () {
  var self = this;

  log.debug("Removing %s from in-memory workspaces.", self.id);
  self.state = ROOM_STATES.DESTROYING;

  delete self.server.workspaces[self.id];
  self.server.update_active_workspaces();
  cache.del(util.format("active_users_%s", self.id));

  if (self.db) {
    ldb.finish_db(self.db, self.id);
  }
};

Room.prototype.loadBufs = function (agent, cb) {
  var self = this,
    finish;

  finish = function (err) {
    if (err) {
      log.error("Error getting buffers for %s in db %s: %s", self.id, self.path, err);
      cb(err);
      return;
    }
    if (_.size(self.bufs) === 0) {
      var createReadme = function (err) {
        var readme = settings.readme.text;
        log.debug("No buffers in workspace %s. Creating README.", self.toString());
        if (err) {
          readme = util.format("%s\n\n%s", err.toString(), readme);
        }
        self.create_buf(settings.readme.name, readme, "utf8", agent, function (err, result) {
          self.readme_buf = result;
          return cb(err, result);
        });
      };

      if (self.repo) {
        log.debug("No buffers in workspace. %s Pulling from repo.", self.toString());
        return self.repo.update(agent, function (err, result) {
          if (err) {
            return createReadme(err);
          }
          return cb(err, result);
        });
      }
      return createReadme();
    }

    cb();
    cb = function () {
      log.error("loadRoom finish called multiple times for %s", self.toString());
    };
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
      buf.load(function (err) {
        if (err) {
          // TODO: also bubble this up
          log.error("Error loading buffer %s: %s", buf.toString(), err);
          return;
        }
        log.debug("Loaded buffer %s", buf.toString());
      });
      self.bufs[buf.id] = buf;
      self.tree_add_buf(buf);
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

Room.prototype.create_buf = function (path, text, encoding, agent, cb) {
  var self = this,
    buf,
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
  self.save();

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

  self.emit("dmp", agent, "create_buf", buf.to_json(agent));
  if (self.readme_buf) {
    self.delete_buf(self.readme_buf.id, agent, true, function () { return; });
    self.readme_buf = null;
  }
  return cb(null, buf);
};

Room.prototype.delete_buf = function (buf_id, agent, unlink, cb) {
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
      self.tree_delete_buf(buf);
    } catch (e) {
      log.error("Error deleting buf %s from tree: %s", buf.toString(), e);
    }
    delete self.bufs[buf_id];
    if (self.last_highlight && self.last_highlight.id === buf_id) {
      self.last_highlight = null;
    }
    self.emit("dmp", agent, "delete_buf", {
      id: buf_id,
      user_id: agent.id,
      username: agent.username,
      path: buf.path,
      unlink: unlink
    });
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

Room.prototype.tree_delete_buf = function (buf) {
  var self = this,
    chunks = buf.path.split("/"),
    file_name = chunks.slice(-1)[0],
    i,
    sub_tree = self.tree;

  for (i = 0; i < chunks.length - 1; i++) {
    sub_tree = sub_tree[chunks[i]];
  }
  delete sub_tree[file_name];
};

Room.prototype.rename_buf = function (buf_id, new_path, agent, cb) {
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

  self.tree_delete_buf(buf);
  buf.path = new_path;
  self.tree_add_buf(buf);

  return buf.save(false, function (err) {
    self.emit("dmp", agent, "rename_buf", {
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
  repo_json = self.repo ? self.repo.to_json() : {};
  self.server.db.put(util.format("version_%s", self.id), self.version, function (err) {
    if (err) {
      return cb(err);
    }
    db.query("UPDATE room_room SET cur_fid = $1, updated_at = $2, repo_info = $3 WHERE id = $4",
      [self.cur_fid, now, JSON.stringify(repo_json), self.id], cb);
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
    if (!self.dirty) {
      log.debug("No changes to buffers. Not increasing version.");
      return (errors.length > 0 || err) ? cb(err || errors) : cb();
    }
    self.version++;
    self.save(function (save_err) {
      self.dirty = false;
      return (errors.length > 0 || err || save_err) ? cb(err || errors || save_err) : cb();
    });
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

  self.emit("dmp", agent, "create_term", term.to_json());
  return cb(null, term);
};

Room.prototype.delete_term = function (agent, id) {
  var self = this;

  delete self.terms[id];
  self.emit("dmp", agent, "delete_term", {
    id: id,
    user_id: agent.id,
    username: agent.username
  });
};

Room.prototype.on_saved = function (agent, req) {
  var self = this;

  self.emit("dmp", agent, "saved", {
    id: req.id,
    user_id: agent.id
  });
};

Room.prototype.on_msg = function (agent, msg_string) {
  var self = this,
    msg = new MSG(agent, msg_string);

  self.emit("dmp", agent, "msg", msg.to_json());
  self.msgs.push(msg);
  self.msgs = self.msgs.slice(-20);
};

Room.prototype.on_datamsg = function (agent, msg) {
  var self = this;

  if (_.size(msg.to) === 0) {
    self.emit("dmp", agent, "datamsg", {
      user_id: agent.id,
      data: msg.data
    });
    return;
  }

  _.each(msg.to, function (user_id) {
    var a = self.agents[user_id];
    if (_.isUndefined(a)) {
      return;
    }
    a.on_dmp(agent, "datamsg", {
      user_id: agent.id,
      data: msg.data
    });
  });
};

Room.prototype.evict = function (reason, cb) {
  var self = this,
    auto = {};

  cb = cb || function () { return; };
  self.state = ROOM_STATES.DESTROYING;

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
    delete self.server.workspaces[self.id];
    self.server.update_active_workspaces();
    return cb(err, result);
  });
};

Room.prototype.part = function (agent) {
  var self = this,
    hangout_agents;

  self.emit("dmp", agent, "part", {"user_id": agent.id, "username": agent.username});

  if (self.temp_data.hangout) {
    hangout_agents = _.find(self.agents, function (agent) {
      return agent.client === "web-hangout";
    });
    if (_.isUndefined(hangout_agents)) {
      log.debug("No more hangout people in the workspace. Deleting hangout temp_data.");
      self.delete_temp_data(agent, ["hangout"]);
    }
  }

  delete self.agents[agent.id];
  self.update_active_users();

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

Room.prototype.update_active_users = function () {
  var self = this,
    agents_json;

  agents_json = _.filter(self.agents, function (agent) {
    return agent.is_anon === false;
  }).map(function (agent) {
    var a = agent.to_json();
    delete a.perms;
    a.user_id = agent.user_id;
    return a;
  });

  cache.set(util.format("active_users_%s", self.id), agents_json);
  if (agents_json.length === 0) {
    self.server.update_active_workspaces();
  } else if (!self.active) {
    self.server.update_active_workspaces();
  }
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

  self.emit("dmp", agent, "set_temp_data", {
    data: data,
    user_id: agent.id,
    username: agent.username
  });
};

Room.prototype.delete_temp_data = function (agent, data) {
  var self = this;

  // TODO: validate and stuff
  _.each(data, function (k) {
    delete self.temp_data[k];
  });
  self.emit("dmp", agent, "delete_temp_data", {
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

exports.Room = Room;
exports.STATES = ROOM_STATES;

exports.add_agent = function (owner, name, agent, user, cb) {
  var db_room,
    finish,
    room,
    server = agent.server;

  finish = function (err) {
    if (err) {
      log.error(err);
      return cb(err);
    }

    if (room.require_ssl && !settings.debug) {
      log.debug("This workspace requires SSL");
      if (!agent.is_ssl) {
        return cb("This workspace requires SSL and you're on an unencrypted connection.");
      }
      log.debug("Agent", agent.toString(), "is on a secure connection.");
    }

    return async.parallel({
      anon_perms: function (cb) {
        perms.for_room(-1, room.id, false, cb);
      },
      agent_perms: function (cb) {
        perms.for_room(user.id, room.id, user.is_superuser, cb);
      }
    }, function (err, res) {
      if (err) {
        log.error(err);
        // This error is sent back to the user...
        return cb();
      }
      room.anon_perms = perms.fine_grained_perms(res.anon_perms);

      agent.perms = perms.fine_grained_perms(res.agent_perms);
      if (agent.perms.length === 0) {
        return cb("user doesn't have permissions");
      }

      // Logged-in users get message privileges
      // TODO: hacky and totally in the wrong place
      if (agent.is_anon === false && _.contains(res.agent_perms, "view_room")) {
        agent.perms.push("msg");
        agent.perms = _.uniq(agent.perms);
      }

      room.agents[agent.id] = agent;
      agent.bufs = room.bufs;

      room.update_active_users();

      return cb(undefined, room);
    });
  };

  log.debug("Adding agent %s for workspace %s owned by %s", agent.toString(), name, owner);

  db.get_room(owner, name, function (err, result) {
    if (err) {
      return finish(err);
    }

    log.log("Found workspace", result.id);
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
    room = new Room(db_room.id,
      db_room.name,
      owner, {
        cur_fid: db_room.cur_fid,
        max_size: db_room.max_size,
        require_ssl: db_room.require_ssl,
        secret: db_room.secret,
        repo_info: JSON.parse(db_room.repo_info)
      },
      server);

    server.workspaces[db_room.id] = room;
    room.once("load", finish);
    room.load(agent);
  });
};
