var util = require('util');
var events = require('events');

var _ = require('underscore');
var request = require("request");

var ColabBuffer = require('./buffer');
var db = require('./db');
var log = require('./log');


var MSG = function(agent, msg){
  var self = this;

  self.user_id = agent.id;
  self.username = agent.username;
  self.time = Date.now()/1000;
  self.data = msg;
};

MSG.prototype.to_json = function(){
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

  log.debug("created new room", id, name, owner);
  events.EventEmitter.call(self);
};

util.inherits(Room, events.EventEmitter);

Room.prototype.get_buf = function (id) {
  var self = this;
  return self.bufs[id];
};

Room.prototype.create_buf = function (path, fid, text) {
  var self = this;
  var buf;
  var err;
  var db_create = false;
  log.debug("creating buf for path", path);
  if (!path || path.length === 0) {
    log.log("Someone gave us an empty path. Byebye.");
    return null;
  } else if (path[0] === '/') {
    log.log("Someone gave us a path starting with /. Byebye.");
    return null;
  }

  if (!_.isFinite(fid)) {
    db_create = true;
    fid = ++self.cur_fid;
    log.debug("updating room_room");
    self.save();
  }
  if (self.get_buf(fid)) {
    log.error("create_buf: Buffer id", fid, "already exists for buf", self.get_buf(fid));
    return null;
  }
  _.each(self.bufs, function(_buf) {
    if (_buf.path === path) {
      log.error("Duplicate path: buffer", _buf.id, "already has path", path);
      err = "Duplicate path";
    }
  });
  if (err) {
    return null;
  }
  buf = new ColabBuffer(self, path, fid, text, db_create);
  self.bufs[buf.id] = buf;
  self.tree_add_buf(buf);

  return buf;
};

Room.prototype.delete_buf = function(buf_id, cb) {
  var self = this;
  var buf = self.get_buf(buf_id);
  if (!buf) {
    return cb("buf does not exist");
  }
  log.debug("deleting buf", buf);

  return db.client.query("UPDATE room_buffer SET deleted = TRUE WHERE fid = $1 AND room_id = $2", [buf.id, self.id], function (err, result) {
    console.log("delete buf err:", err, "result:", result);
    if (err) {
      return cb(err, result);
    }
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
      log.warn('trying to stomp path', buf.path);
      return;
    }
    sub_tree = sub_tree[chunk];
    if (sub_tree === undefined) {
      break;
    }
  }

  sub_tree = self.tree;
  _.each(chunks, function(chunk, pos) {
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

Room.prototype.rename_buf = function(buf_id, new_path, cb) {
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

    if (this_buf.path === path) {
      err = new Error(util.format("Duplicate path: buffer %s already has path: %s", this_buf.id, path));
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
    "users": _.map(self.agents, function (agent, id) {
      return agent.username;
    }),
    "bufs": {}
  };
  _.each(self.bufs, function(buf, id){
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

Room.prototype.on_msg = function(agent, msg_string){
  var self = this;
  var msg = new MSG(agent, msg_string);

  self.emit("dmp", agent, "msg", msg.to_json());
  self.msgs.push(msg);
  self.msgs = self.msgs.slice(-20);
};

exports.Room = Room;

exports.add_agent = function (owner, name, agent, cb) {
  var room_id;
  var room;
  var db_room;
  log.debug("adding agent for room", name, "owned by", owner);
  db.get_room(owner, name, function (err, result) {
    if (err) {
      return err;
    }
    log.log("found room", result.id);
    db_room = result;

    if (db_room === undefined) {
      log.error("room id not found for", owner, name);
      return cb("room not found");
    }
    room = agent.server.rooms[db_room.id];

    if (room === undefined) {
      // Room was created after we started the server.
      room = new Room(db_room.id, db_room.name, db_room.user_id);
      room.cur_fid = db_room.cur_fid;
      agent.server.rooms[db_room.id] = room;

      db.client.query("SELECT * FROM room_buffer WHERE room_id = $1", [db_room.id], function (err, result) {
        if (err) {
          log.error(err);
        } else {
          _.each(result.rows, function (row) {
            room.create_buf(row.path, row.fid, row.cur_state);
          });
        }
      });
    }

    if (agent.is_anon === true) {
      agent.allowed_actions = utils.db_perms_mapping[db_room.perms];
    }

    if (agent.allowed_actions.length === 0) {
      return cb("user doesn't have permissions");
    }

    room.agents[agent.id] = agent;
    agent.bufs = room.bufs;
    room.on("dmp", agent.dmp_listener);
    room.emit("dmp", agent, "join", {"username": agent.username});
    return cb(undefined, room);
  });
};
