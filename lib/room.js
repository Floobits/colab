var events = require("events");
var util = require("util");

var _ = require("underscore");
var async = require("async");
var request = require("request");

var ColabBuffer = require("./buffer");
var db = require("./db");
var log = require("./log");
var s3 = require("./s3");
var settings = require("./settings");
var Repo = require("./repo");
var utils = require("./utils");


var path_chunk_blacklist = [
  "",
  ".",
  ".."
];

var MSG = function (agent, msg) {
  var self = this;

  self.user_id = agent.id;
  self.username = agent.username;
  self.time = Date.now()/1000;
  self.data = msg;
};

MSG.prototype.to_json = function () {
  var self = this;

  return {
    user_id: self.user_id,
    username: self.username,
    time: self.time,
    data: self.data
  };
};

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
  self.msgs = [];
  self.last_highlight = null;
  self.require_ssl = atts.require_ssl;

  if (atts.repo_info && !_.isEmpty(atts.repo_info)) {
    self.repo = new Repo(self, atts.repo_info);
  }

  log.debug("created new room", id, name, owner);
  events.EventEmitter.call(self);
};

util.inherits(Room, events.EventEmitter);

Room.prototype.toString = function() {
  var self = this;
  return util.format("%s %s/%s", self.id, self.owner, self.name);
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

Room.prototype.create_buf = function (path, text, agent, cb) {
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
  if (path[path.length-1] === "/") {
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
      err = '"' + chunk +'" is not an allowed file or directory name';
    }
  });
  if (err) {
    return cb(err);
  }

  dup_buf = self.get_buf_by_path(path);
  if (dup_buf) {
    return cb("Duplicate path. Buffer " + dup_buf.id + " already has path " + path);
  }

  fid = ++self.cur_fid;
  self.save();

  if (self.get_buf(fid)) {
    return cb("create_buf: Buffer id " + fid + " already exists for buf " + self.get_buf(fid));
  }

  buf = new ColabBuffer(self, path, fid, text, undefined, true);
  self.bufs[buf.id] = buf;
  self.tree_add_buf(buf);

  self.emit("dmp", agent, "create_buf", buf.to_json());
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

  return db.client.query("UPDATE room_buffer SET deleted = TRUE WHERE fid = $1 AND room_id = $2", [buf.id, self.id], function (err, result) {
    if (err) {
      log.error("delete buf err:", err, "result:", result);
      return cb(err, result);
    }
    log.debug("marked buf", buf.toString(), "as deleted. removing from tree");
    self.tree_delete_buf(buf);
    delete self.bufs[buf_id];
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

  for (i = 0; i < chunks.length-1; i++) {
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

Room.prototype.to_json = function () {
  var self = this,
    room_info = {
      "tree": self.tree,
      "owner": self.owner,
      "users": {},
      "bufs": {}
    };

  _.each(self.agents, function (agent, id) {
    room_info.users[id] = agent.username;
  });
  _.each(self.bufs, function (buf, id) {
    room_info.bufs[id] = buf.to_json();
    // Buffers can be huge. Just send the paths and md5s. The client can ask for what it needs
    delete room_info.bufs[id].buf;
  });
  return room_info;
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

  cb = cb || function(){};
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
      if (err){
        log.error("failure to save buffer:", buf.guid, err);
        errors.push(buf);
      }
      cb();
    });
  }, function (err) {
    return (errors.length > 0 || err) ? cb(err || errors) : cb();
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
  var self = this;

  self.emit("dmp", agent, "part", {"user_id": agent.id, "username": agent.username});
  self.removeListener("dmp", agent.dmp_listener);
  delete self.agents[agent.id];
  if (_.isEmpty(self.agents)) {
    log.debug("Room is empty. Removing from in-memory rooms.");
    self.save_bufs(function (err) {
      if (!err) {
        delete agent.server.rooms[self.id];
      }
    });
  }
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
      log.debug("This room requires SSL");
      if (agent && agent.conn && agent.conn.manager) {
        switch (agent.conn.manager.server) {
          case agent.server.io.server:
          case agent.server.server:
            return cb("This room requires SSL and you're on an unencrypted connection.");

          case agent.server.io_ssl.server:
          case agent.server.server_ssl:
            log.debug("Agent", agent.toString(), "is on a secure connection.");
          break;
          default:
            log.error("We don't know what kind of connection agent", agent, "is on!");
            return cb("This room requires SSL, but we can't figure out whether your connection is secure. Erring on the side of caution and disconnecting you. This is probably a bug. Sorry.");
        }
      }
    }

    return db.get_perms(user.id, room.id, function (err, result) {
      if (err) {
        log.error(err);
        return cb();
      }
      if (user.is_superuser) {
        _.each(utils.db_perms_mapping, function (perms, codename) {
          agent.allowed_actions = agent.allowed_actions.concat(perms);
        });
      } else {
        _.each(result, function (r) {
          agent.allowed_actions = agent.allowed_actions.concat(utils.db_perms_mapping[r.codename]);
        });
      }
      agent.allowed_actions = _.uniq(agent.allowed_actions);
      if (agent.allowed_actions.length === 0) {
        return cb("user doesn't have permissions");
      }

      room.agents[agent.id] = agent;
      agent.bufs = room.bufs;
      room.on("dmp", agent.dmp_listener);
      room.emit("dmp", agent, "join", {"user_id": agent.id, "username": agent.username});
      return cb(undefined, room);
    });
  };

  log.debug("adding agent for room", name, "owned by", owner);

  db.get_room(owner, name, function (err, result) {
    if (err) {
      return cb(err);
    }

    log.log("found room", result.id);
    db_room = result;

    if (db_room === undefined) {
      log.error("room id not found for", owner, name);
      return cb("room not found");
    }
    room = agent.server.rooms[db_room.id];

    if (room !== undefined) {
      return finish();
    }

    try {
      room = new Room(db_room.id, db_room.name, db_room.user_id, {
        cur_fid: db_room.cur_fid,
        require_ssl: db_room.require_ssl,
        repo_info: JSON.parse(db_room.repo_info)
      });
    } catch (e) {
      return cb(e.toString());
    }
    agent.server.rooms[db_room.id] = room;

    return db.client.query("SELECT * FROM room_buffer WHERE room_id = $1 AND deleted = FALSE", [db_room.id], function (err, result) {
      if (err) {
        log.error("error getting buffers for room", db_room.id, err);
        return cb(err, result);
      }
      if (result.rows.length === 0) {
        // No buffers in the room. Show some help text.
        return room.create_buf("README.md", settings.readme_text, agent, finish);
      }
      return async.each(result.rows, function (row, callback) {
        var buf = new ColabBuffer(room, row.path, row.fid, undefined, row.md5, false);
        buf.load(function (err, result) {
          if (err) {
            log.error("Error loading buf. Retrying.");
            // TODO: Retry more than once?
            buf.load(function (err, result) {
              if (err) {
                try {
                  agent.disconnect("Error loading buffer" + buf.id + ": " + err);
                  // TODO: log this or alert
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
          log.error("Error loading room:", err);
          return cb(util.format("Error loading buffer in room: %s", err));
        }
        return finish(err, result);
      });
    });
  });
};
