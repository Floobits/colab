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
  // Client added
  add: function (room) {
    return [room.id, room];
  },
  // Client removed
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
  add_colab: function (workspace_id, agent, cb) {
    return [workspace_id, agent, cb];
  },
  // Version names/etc updated
  update: function (workspace_id) {
    return [workspace_id];
  },
});

var Broadcast = flux.createActions({
  send_to_master: function (type, data, cb) {
    return [type, data, cb];
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
  },
  delete_workspace: function (id, workspace) {
    return [id, workspace];
  },
  evict_workspace: function (id, workspace) {
    return [id, workspace];
  },
  update_workspace: function (id, workspace) {
    return [id, workspace];
  },
});

module.exports = {
  conn: new Conn(),
  room: new Room(),
  slave: new Slave(),
  broadcast: new Broadcast(),
};
