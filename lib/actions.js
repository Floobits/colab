"use strict";

const util = require("util");

const flux = require("flukes");

const Conn = flux.createActions({
  end: function (conn) {
    return conn;
  },
  handler: function (conn_id, handler) {
    return [conn_id, handler];
  }
});

const Room = flux.createActions({
  // Client added
  add: function (room) {
    return [room.id, room];
  },
  // Client removed
  remove: function (room) {
    return [room.id, room];
  },
  add_agent: function (room_path, agent, user, cb) {
    let name;
    let owner;
    const path_parts = room_path.split("/");

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
  // Only fires off if we delete it ourselves, not when servicing a request from master
  delete: function (workspace_id) {
    workspace_id = parseInt(workspace_id, 10);
    return [workspace_id];
  },
  // Version names/etc updated
  update: function (workspace_id, workspace) {
    return [workspace_id, workspace];
  },
});

const Broadcast = flux.createActions({
  send_to_master: function (type, data, cb) {
    return [type, data, cb];
  },
  send_to_slaves: function (source, data, cb) {
    return [source, data, cb];
  },
  send_to_path: function (from, to, data, cb) {
    return [from, to, data, cb];
  },
  send_to_user: function (from, to, data, cb) {
    return [from, to, data, cb];
  },
  solicit: function (from, data, cb) {
    from = util.format("%s/%s", from.owner, from.name);
    return [from, data, cb];
  },
});

const Slave = flux.createActions({
  add: function (id, handler) {
    return [id, handler];
  },
  remove: function (id) {
    return id;
  },
  update_counts: function (id, workspaces) {
    return [id, workspaces];
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
