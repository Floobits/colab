var util = require('util');
var events = require('events');

var _ = require('underscore');
var async = require('async');
var request = require("request");

var ColabBuffer = require('./buffer');
var db = require('./db');
var log = require('./log');
var s3 = require('./s3');
var settings = require('./settings');
var utils = require('./utils');


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

var Room = function (id, name, owner) {
  var self = this;
  self.id = id;
  self.name = name;
  self.owner = owner;
  self.agents = {};
  self.bufs = {};
  // directory in json :)
  self.tree = {};
  self.cur_fid = 0;
  self.msgs = [];
  self.last_highlight = null;

  log.debug("created new room", id, name, owner);
  events.EventEmitter.call(self);
};

util.inherits(Room, events.EventEmitter);

Room.prototype.get_buf = function (id) {
  var self = this;
  return self.bufs[id];
};

Room.prototype.create_buf = function (path, text, cb) {
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
  } else if (path[0] === "/") {
    return cb("Buffer path can't start with /. Byebye.");
  } else if (path[path.length-1] === "/") {
    return cb("Buffer path can't end with a /. Byebye.");
  } else if (path.search("//") > 0) {
    return cb("Buffer path can't have consecutive slashes in it.");
  } else if (settings.max_buf_len && text.length > settings.max_buf_len) {
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

  dup_buf = _.find(self.bufs, function (buf, id) {
    return buf.path === path;
  });
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

  return cb(null, buf);
};

Room.prototype.delete_buf = function (buf_id, cb) {
  var self = this;
  var buf = self.get_buf(buf_id);
  if (!buf) {
    return cb("buf does not exist");
  }
  log.debug("deleting buf", buf);

  return db.client.query("UPDATE room_buffer SET deleted = TRUE WHERE fid = $1 AND room_id = $2", [buf.id, self.id], function (err, result) {
    if (err) {
      log.error("delete buf err:", err, "result:", result);
      return cb(err, result);
    }
    log.debug("marked buf", buf.id, buf.path, "as deleted. removing from tree");
    self.tree_delete_buf(buf);
    delete self.bufs[buf_id];
    return cb(null, buf);
  });
};

Room.prototype.tree_add_buf = function (buf) {
  var self = this;
  var sub_tree = self.tree;
  var chunks = buf.path.split("/");
  var file_name = chunks.slice(-1)[0];
  var chunk;
  var i;

  // GOOD INTERVIEW QUESTION
  for (i = 0; i < chunks.length; i++) {
    chunk = chunks[i];
    if (i == chunks.length - 1 && sub_tree[chunk] !== undefined) {
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
  var self = this;
  var chunks = buf.path.split("/");
  var file_name = chunks.slice(-1)[0];
  var sub_tree = self.tree;
  var i;

  for (i = 0; i < chunks.length-1; i++) {
    sub_tree = sub_tree[chunks[i]];
  }
  delete sub_tree[file_name];
};

Room.prototype.rename_buf = function (buf_id, new_path, cb) {
  var self = this;
  var this_buf;
  var buf = self.get_buf(buf_id);
  var old_path;
  var err;
  if (!buf) {
    return cb("buf does not exist");
  }
  old_path = buf.path;
  log.debug("renaming buf", old_path, "to", new_path);

  for (var i=0; i<self.bufs.length; i++) {
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
    return cb(err, old_path);
  });
};

Room.prototype.to_json = function () {
  var self = this;
  var room_info = {
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
  var self = this;
  var buf_paths = {};
  _.each(self.bufs, function (buf, path) {
    buf_paths[path] = {
      "md5": buf._md5
    };
  });
  return buf_paths;
};

Room.prototype.save = function () {
  var self = this;
  var now = new Date();
  db.client.query("UPDATE room_room SET cur_fid = $1, updated_at = $2 WHERE id = $3",
  [self.cur_fid, now, self.id],
  function (err, result) {
    log.debug(result);
    if (err) {
      log.error(err);
    }
  });
};

Room.prototype.save_bufs = function(cb) {
  var self = this;
  var errors = [];
  async.eachLimit(_.values(self.bufs), 20, function(buf, cb) {
    buf.save(false, function(err) {
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
  var self = this;
  var msg = new MSG(agent, msg_string);

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

  finish = function(err) {
    if (err){
      log.error(err);
      cb();
      return;
    }

    db.get_perms(user.id, room.id, function (err, result) {
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
    // Room was created after we started the server.
    room = new Room(db_room.id, db_room.name, db_room.user_id);
    room.cur_fid = db_room.cur_fid;
    agent.server.rooms[db_room.id] = room;

    return db.client.query("SELECT * FROM room_buffer WHERE room_id = $1 AND deleted = FALSE", [db_room.id], function (err, result) {
      if (err) {
        log.error("error getting buffers for room", db_room.id, err);
        cb(err, result);
        return;
      }
      async.each(result.rows, function (row, callback) {
        var buf = new ColabBuffer(room, row.path, row.fid, undefined, row.md5, false);
        buf.load();
        room.bufs[buf.id] = buf;
        room.tree_add_buf(buf);
        callback();
      }, finish);
    });
  });
};
