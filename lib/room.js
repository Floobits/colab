var util = require('util');
var events = require('events');

var _ = require('underscore');
var request = require("request");

var ColabBuffer = require('./buffer');
var db = require('./db');
var log = require('./log');


// TODO: these strings are also in agent.js
var db_perms_mapping = {
  0: [],
  1: ["get_buf"],
  2: ["patch", "get_buf", "create_buf", "highlight", "msg", "delete_buf", "rename_buf"]
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
  log.debug("creating buf for path", path);
  if (!path || path.length === 0) {
    log.log("Someone gave us an empty path. Byebye.");
    return null;
  }

  var sub_tree = self.tree;
  var chunks = path.split("/");
  var file_name = chunks.slice(-1)[0];
  var chunk;
  var i;
  var db_create = false;
  var buf;

  // GOOD INTERVIEW QUESTION
  for (i = 0; i < chunks.length; i++) {
    chunk = chunks[i];
    if (i == chunks.length - 1 && sub_tree[chunk] !== undefined) {
      log.warn('trying to stomp path', path);
      return null;
    }
    sub_tree = sub_tree[chunk];
    if (sub_tree === undefined) {
      break;
    }
  }

  if (fid === undefined) {
    db_create = true;
    fid = ++self.cur_fid;
    log.debug("updating room_room");
    self.save();
  }
  buf = new ColabBuffer(self, path, fid, text, db_create);
  self.bufs[buf.id] = buf;
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

  return buf;
};

Room.prototype.delete_buf = function(buf_id, cb) {
  var self = this;
  var buf = self.get_buf(buf_id);
  if (!buf) {
    return cb("buf does not exist");
  }
  log.debug("deleting buf", buf);
  var chunks = buf.path.split("/");
  var file_name = chunks.slice(-1)[0];
  var sub_tree = self.tree;
  var i;

  for (i = 0; i < chunks.length-1; i++) {
    sub_tree = sub_tree[chunks[i]];
  }

  if (sub_tree) {
    delete sub_tree[file_name];
  }
  delete self.bufs[buf_id];
  //TODO: munge DB
  return cb(null, "success!");
};

Room.prototype.rename_buf = function(buf_id, new_path, cb) {
  var self = this;
  var buf = self.get_buf(buf_id);
  if (!buf) {
    return cb("buf does not exist");
  }
  log.debug("renaming buf", buf);

  return cb(null, "success!");
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
    /* TODO: one day this will be too big.
    a better solution is to send the paths and checksums,
    then let the client get buffers when it wants */
    room_info.bufs[id] = buf.to_json();
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
    log.log("found room", result);
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
      agent.allowed_actions = db_perms_mapping[db_room.perms];
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
