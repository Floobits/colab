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
  }
});

var Slave = flux.createActions({
  add: function (id, handler) {
    return [id, handler];
  },
  remove: function (id) {
    return id;
  },
  update_counts: function (id, stuff) {
    return [id, stuff];
  },
  update_load: function (id, stuff) {
    return [id, stuff];
  }
});

module.exports = {
  conn: new Conn(),
  room: new Room(),
  slave: new Slave(),
};
