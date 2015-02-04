/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var flux = require("flukes");

var Conn = flux.createActions({
  end: function (conn) {
    return conn;
  },
  handler: function (conn_id, handler) {
    return [conn_id, handler];
  }
});

var Room = flux.createActions({
  add: function (room) {
    return [room.id, room];
  },
  remove: function (room) {
    return [room.id, room];
  },
  add_agent: function (room_path, agent, user, cb) {
    var name,
      owner,
      path_parts = room_path.split("/");

    if (path_parts.length === 1) {
      owner = path_parts[0];
      name = "";
    } else if (path_parts.length === 2) {
      owner = path_parts[0];
      name = path_parts[1];
    } else {
      cb("Invalid path");
      return new Error("Invalid path");
    }
    return [owner, name, agent, user, cb];
  },
});

var Broadcast = flux.createActions({
  send_to_master: function (data, cb) {
    return [{data: data}, cb];
  },
  send_to_slaves: function (data, cb) {
    return [data, cb];
  },
  send_to_user: function (data) {
    return [data];
  },
  solicit: function (data) {
    return data;
  }
});

var Slave = flux.createActions({
  add: function (id, handler) {
    return [id, handler];
  },
  remove: function (id) {
    return id;
  },
  update_count: function (id, stuff) {
    return [id, stuff];
  },
  create_workspace: function (id, workspace) {
    return [id, workspace];
  }
});

module.exports = {
  conn: new Conn(),
  room: new Room(),
  slave: new Slave(),
  broadcast: new Broadcast(),
};
