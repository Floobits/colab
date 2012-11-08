var util = require('util');
var events = require('events');

var _ = require('underscore');
var request = require("request");

var ColabBuffer = require('./buffer');
var db = require('./db');
var log = require('./log');


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

  var sub_tree = self.tree;
  var chunks = path.split("/");
  var file_name = chunks.slice(-1)[0];
  var chunk;
  var i;
  var db_create = false;

  // GOOD INTERVIEW QUESTION
  for (i = 0; i < chunks.length; i++) {
    chunk = chunks[i];
    if (i == chunks.length - 1 && sub_tree[chunk] !== undefined) {
      log.warn('trying to stomp path', path);
      return;
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
    // TODO: probably want to die or something if this fucks up
    db.client.query("UPDATE room_room SET cur_fid = $1 WHERE id = $2", [self.cur_fid, self.id], function (err, result) {
      log.debug(result);
      if (err) {
        log.error(err);
      }
    });
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

exports.Room = Room;

exports.add_agent = function (owner, name, agent, cb) {
  var room_id;
  var room;
  var db_room;
  log.debug("adding agent for room", name, "owned by", owner);
  db.get_room(owner, name, function (err, result) {
    if (err) {
      return log.error(err);
    }
    log.log("found room", result);
    db_room = result;

    if (db_room === undefined) {
      log.error("room id not found for", owner, name);
      return cb("room not found");
    }
    room = agent.server.rooms[db_room.id];

    // TODO: if not found, try grabbing the room from the db. maybe it was recently created
    if (room === undefined) {
      //room = new Room(undefined, name, agent.user_id);
      //agent.server.rooms[name] = room;
      // TODO: tell django to create the room or something
      return cb("room not found", room);
    }

    room.agents[agent.id] = agent;
    agent.bufs = room.bufs;
    room.on('dmp', agent.dmp_listener);
    if (name === "yc_demo" && agent.username !== "ggreer") {
      log.debug("SOMEONE JOINED YC DEMO ROOM");
      request.post("https://ACcab86686993c42870c58effa2355b99a:e3a8fd5077adaccebd90952d314c0777@api.twilio.com/2010-04-01/Accounts/ACcab86686993c42870c58effa2355b99a/SMS/Messages.json", {
        form: {
          From: "+15108783772",
          To: "+14153435517",
          Body: "SOMEONE IS LOOKING AT HN DEMO!!!!!1111"
        }
      });
    }
    return cb(undefined, room);
  });
};
