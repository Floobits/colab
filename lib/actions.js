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

var Colab = flux.createActions({
  add: function (room) {
    return [room.id, room];
  },
  remove: function (room) {
    return [room.id, room];
  }
});

module.exports = {
  conn: new Conn(),
  room: new Room(),
  colab: new Colab(),

};
