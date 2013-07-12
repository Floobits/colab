var events = require("events");
var path = require("path");
var url = require("url");
var util = require("util");

var _ = require("underscore");
var async = require("async");

var make_buffer = require("./buffer").make_buffer;
var ColabTerm = require("./term");
var db = require("./db");
var log = require("./log");
var MSG = require("./msg");
var s3 = require("./s3");
var settings = require("./settings");
var Repo = require("./repo");
var perms = require("./perms");
var utils = require("./utils");


var path_chunk_blacklist = [
  "",
  ".",
  ".."
];

var Room = function (id, name, owner, atts) {
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
  self.path = path.normalize(path.join(settings.buf_storage.local.dir, self.id.toString()));
  self.temp_data = {};

  if (atts.repo_info && !_.isEmpty(atts.repo_info)) {
    self.repo = new Repo(self, atts.repo_info);
  }

  if (self.id >= 0) {
    /*jslint stupid: true */
    utils.mkdirSync(self.path);
    /*jslint stupid: false */
  }

  log.debug("created new workspace", id, name, owner);
  events.EventEmitter.call(self);
};

util.inherits(Room, events.EventEmitter);

Room.prototype.toString = function () {
  var self = this;
  return util.format("%s %s/%s", self.id, self.owner, self.name);
};

Room.prototype.to_json = function (agent) {
  var self = this,
    room_info = {
      "room_name": self.name,
      "tree": self.tree,
      "owner": self.owner,
      "users": {},
      "bufs": {},
      "max_size": self.max_size,
      "temp_data": self.temp_data,
      "terms": {}
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
  var self = this;
  return self.bufs[id];
};

Room.prototype.get_buf_by_path = function (path) {
  var self = this,
    buf;
  buf = _.find(self.bufs, function (buf, id) {
    return buf.path === path;
  });
  return buf;
};

Room.prototype.bufs_size = function () {
  var self = this,
    bufs_size = 0;

  _.each(self.bufs, function (buf, buf_id) {
    if (buf._state) {
      bufs_size += buf._state.length;
    }
    // If the user is lucky enough to create a buffer before we're done loading, I guess it's not a huge deal
  });
  return bufs_size;
};

Room.prototype.create_buf = function (path, text, encoding, agent, cb) {
  var self = this,
    buf,
    dup_buf,
    err,
    fid;

  if (cb === undefined) {
    cb = function () {};
  }
  log.debug("creating buf for path", path);
  if (!path || path.length === 0) {
    return cb("Buffer path can't be empty. Byebye.");
  }
  if (path[0] === "/") {
    return cb("Buffer path can't start with /. Byebye.");
  }
  if (path[path.length - 1] === "/") {
    return cb("Buffer path can't end with a /. Byebye.");
  }
  if (path.search("//") > 0) {
    return cb("Buffer path can't have consecutive slashes in it.");
  }
  if (settings.max_buf_len && text.length > settings.max_buf_len) {
    return cb("Buffer is too big. Max buffer size is", settings.max_buf_len, "bytes.");
  }

  _.each(path.split("/"), function (chunk) {
    if (_.contains(path_chunk_blacklist, chunk)) {
      err = '"' + chunk + '" is not an allowed file or directory name';
    }
  });
  if (err) {
    return cb(err);
  }

  dup_buf = self.get_buf_by_path(path);
  if (dup_buf) {
    return cb("Duplicate path. Buffer " + dup_buf.id + " already has path " + path);
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
  } catch (e) {
    log.error(e);
    return cb("Couldn't create buffer containing binary data.");
  }
  self.bufs[buf.id] = buf;
  self.tree_add_buf(buf);

  self.emit("dmp", agent, "create_buf", buf.to_json(agent));
  if (self.readme_buf) {
    self.delete_buf(self.readme_buf.id, agent, function () {});
    self.readme_buf = null;
  }
  return cb(null, buf);
};

Room.prototype.delete_buf = function (buf_id, agent, cb) {
  var self = this,
    buf = self.get_buf(buf_id);
  agent = agent || {};
  if (!buf) {
    return cb("buf does not exist");
  }
  log.debug("deleting buf", buf.toString());

  buf.cancel_timeouts();

  return db.client.query("UPDATE room_buffer SET deleted = TRUE WHERE fid = $1 AND room_id = $2", [buf.id, self.id], function (err, result) {
    if (err) {
      log.error("delete buf err:", err, "result:", result);
      return cb(err, result);
    }
    log.debug("marked buf", buf.toString(), "as deleted. removing from tree");
    self.tree_delete_buf(buf);
    delete self.bufs[buf_id];
    if (self.last_highlight && self.last_highlight.id === buf_id) {
      self.last_highlight = null;
    }
    self.emit("dmp", agent, "delete_buf", {
      id: buf_id,
      user_id: agent.id,
      username: agent.username,
      path: buf.path
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
    err,
    i,
    old_path,
    this_buf;

  agent = agent || {};
  if (!buf) {
    return cb("buf does not exist");
  }
  old_path = buf.path;
  log.debug("renaming buf", old_path, "to", new_path);

  for (i = 0; i < self.bufs.length; i++) {
    this_buf = self.bufs[i];

    if (this_buf.path === new_path) {
      err = new Error(util.format("Duplicate path: buffer %s already has path: %s", this_buf.id, this_buf.path));
      log.error(err);
      return cb(err, old_path);
    }
  }

  self.tree_delete_buf(buf);
  buf.path = new_path;
  self.tree_add_buf(buf);

  return buf.save(false, function (err, result) {
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

  cb = cb || function () {};
  repo_json = self.repo ? self.repo.to_json() : {};
  db.client.query("UPDATE room_room SET cur_fid = $1, updated_at = $2, repo_info = $3 WHERE id = $4",
    [self.cur_fid, now, JSON.stringify(repo_json), self.id], cb);
};

Room.prototype.save_bufs = function (cb) {
  var self = this,
    errors = [];

  async.eachLimit(_.values(self.bufs), 20, function (buf, cb) {
    buf.save(false, function (err) {
      // TODO: handle error by saving buf to disk
      if (err) {
        log.error("failure to save buffer:", buf.guid, err);
        errors.push(buf);
      }
      cb();
    });
  }, function (err) {
    return (errors.length > 0 || err) ? cb(err || errors) : cb();
  });
};

Room.prototype.get_term = function (id) {
  var self = this;
  return self.terms[id];
};

Room.prototype.create_term = function (agent, name, size) {
  var self = this,
    term,
    term_id;

  if (!name || name === "") {
    agent.error("A name is required when creating a terminal.");
    return;
  }

  if (!name.match(/^[a-zA-Z0-9\-_]+$/)) {
    agent.error("Terminal names can only contain letters, numbers, dashes and underscores.");
    return;
  }
  term = _.find(self.terms, function (term, id) {
    return term.name === name;
  });

  if (!_.isArray(size)) {
    size = [100, 35];
  } else {
    size = size.slice(0, 2);
  }

  if (term) {
    agent.error("A terminal with this name already exists.");
    return;
  }

  term_id = ++self.cur_term_id;

  term = new ColabTerm(self, term_id, agent, name, size);
  self.terms[term_id] = term;

  self.emit("dmp", agent, "create_term", term.to_json());
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

Room.prototype.part = function (agent) {
  var self = this,
    hangout_agents;

  self.emit("dmp", agent, "part", {"user_id": agent.id, "username": agent.username});
  self.removeListener("dmp", agent.dmp_listener);

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
  if (_.isEmpty(self.agents)) {
    log.debug("Workspace is empty. Removing from in-memory workspaces.");
    self.save_bufs(function (err) {
      if (!err) {
        delete agent.server.workspaces[self.id];
      }
    });
  }
};

Room.prototype.set_temp_data = function (agent, data) {
  var self = this,
    changed = false,
    msg,
    temp_data,
    key,
    url_obj;

  // TODO: validate and stuff
  if (_.keys(data).length > 1) {
    log.debug("too many keys");
    return;
  }
  if (!data.hangout || !data.hangout.url) {
    log.debug("no hangout url key");
    return;
  }
  url_obj = url.parse(data.hangout.url);
  if (url_obj.protocol !== "https:" || !url_obj.hostname.match(/\.google\.com$/)) {
    log.debug("hangout url does not match");
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
  var self = this,
    msg;

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

Room.prototype.request_perms = function (agent, perms) {
  var self = this,
    admins;

  admins = _.filter(self.agents, function (user) {
    return _.contains(user.perms, "perms");
  });

  if (_.isEmpty(admins)) {
    return agent.error("Permission request failed: There are no admins in this workspace.", true);
  }

  _.each(admins, function (admin) {
    admin.write("request_perms", {
      user_id: agent.id,
      perms: perms
    });
  });
};

exports.Room = Room;

exports.add_agent = function (owner, name, agent, user, cb) {
  var room,
    db_room,
    finish;

  finish = function (err) {
    if (err) {
      log.error(err);
      return cb(err);
    }

    if (room.require_ssl && !settings.debug) {
      log.debug("This workspace requires SSL");
      if (agent.is_ssl()) {
        return cb("This workspace requires SSL and you're on an unencrypted connection.");
      }
      log.debug("Agent", agent.toString(), "is on a secure connection.");
    }

    return perms.for_room(user.id, room.id, user.is_superuser, function (err, perms_list) {
      var fine_grained_perms = [];

      if (err) {
        log.error(err);
        return cb();
      }

      _.each(perms_list, function (perm) {
        fine_grained_perms = fine_grained_perms.concat(perms.db_perms_mapping[perm]);
      });

      agent.perms = _.uniq(fine_grained_perms);
      if (agent.perms.length === 0) {
        return cb("user doesn't have permissions");
      }

      room.agents[agent.id] = agent;
      agent.bufs = room.bufs;
      room.on("dmp", agent.dmp_listener);
      room.emit("dmp", agent, "join", agent.to_json());
      return cb(undefined, room);
    });
  };

  log.debug("adding agent for workspace", name, "owned by", owner);

  db.get_room(owner, name, function (err, result) {
    if (err) {
      return cb(err);
    }

    log.log("found workspace", result.id);
    db_room = result;

    if (db_room === undefined) {
      log.error("workspace id not found for", owner, name);
      return cb("workspace not found");
    }
    room = agent.server.workspaces[db_room.id];

    if (room !== undefined) {
      if (!room.allow_new_users) {
        return cb("No new users are allowed in this workspace. It is probably being deleted.");
      }
      // TODO: this probably behaves weirdly if the workspace was renamed in django
      _.each(["max_size", "require_ssl"], function (k) {
        room[k] = db_room[k];
      });
      return finish();
    }

    try {
      room = new Room(db_room.id, db_room.name, owner, {
        cur_fid: db_room.cur_fid,
        max_size: db_room.max_size,
        require_ssl: db_room.require_ssl,
        repo_info: JSON.parse(db_room.repo_info)
      });
    } catch (e) {
      return cb(e.toString());
    }
    agent.server.workspaces[db_room.id] = room;

    return db.client.query("SELECT * FROM room_buffer WHERE room_id = $1 AND deleted = FALSE", [db_room.id], function (err, result) {
      if (err) {
        log.error("error getting buffers for room", db_room.id, err);
        return cb(err, result);
      }
      if (result.rows.length === 0) {
        // No buffers in the room. Show some help text.
        return room.create_buf(settings.readme.name, settings.readme.text, "utf8", agent, function (err, result) {
          room.readme_buf = result;
          return finish(err, result);
        });
      }
      return async.eachLimit(result.rows, 20,
        function (row, callback) {
          var buf;
          try {
            buf = make_buffer(room, row.fid, row.path, new Buffer(0), row.md5, false, db.buf_encodings_mapping[row.encoding]);
          } catch (e) {
            return callback(e);
          }
          buf.load(function (err, result) {
            if (err) {
              log.error("Error loading buf. Retrying.");
              // TODO: Retry more than once?
              buf.load(function (err, result) {
                if (err) {
                  try {
                    agent.disconnect(util.format("Error loading buffer %s: %s", buf.id, err));
                  } catch (e) {
                    log.error("Error disconnecting client after error loading buffer:", e);
                  }
                }
              });
            }
          });
          room.bufs[buf.id] = buf;
          room.tree_add_buf(buf);
          callback();
        },
        function (err, result) {
          if (err) {
            log.error("Error loading workspace:", err);
            return cb(util.format("Error loading buffer in workspace: %s", err));
          }
          return finish(err, result);
        });
    });
  });
};
