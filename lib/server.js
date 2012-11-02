var net = require('net');
var util = require('util');
var events = require('events');

var settings = require('./settings');

var _ = require('underscore');
var io = require('socket.io').listen(settings.socket_io_port);

var agent = require('./agent');
var room = require('./room');
var log = require('./log');
var db = require('./db');

var ColabServer = function () {
  var self = this;
  self.conn_number = 0;
  self.agents = {};
  self.rooms = {};
};

util.inherits(ColabServer, net.Server);

ColabServer.prototype.load_rooms = function (cb) {
  var self = this;
  var query = db.query("SELECT * from room_room");
  query.on("row", function (row) {
    log.debug(row);
    self.rooms[row.id] = new room.Room(row.name, row.user_id);
  });
  query.on("end", cb);
};

ColabServer.prototype.listen = function (port, address) {
  var self = this;
  net.Server.call(self, self.on_conn.bind(self));
  net.Server.prototype.listen.call(self, port, address);
  log.log('Listening on port ' + port);

  io.configure(function () {
    io.set('transports', settings.socket_io_transports);
    io.enable('log');
  });
  io.sockets.on('connection', self.on_sio_conn.bind(self));
};

ColabServer.prototype.on_conn = function (conn) {
  var self = this;
  var number = ++self.conn_number;
  var agent_conn = new agent.AgentConnection(number, conn, self);
  self.agents[number] = agent_conn;
  log.debug('client', number, 'connected');
  agent.once('on_conn_end', self.on_conn_end.bind(self));
};

ColabServer.prototype.on_conn_end = function (agent_conn) {
  var self = this;
  if (agent_conn.room) {
    agent_conn.room.removeListener('dmp', agent_conn.dmp_listener);
    delete agent_conn.room.agents[agent.id];
  }
  delete self.agents[agent_conn.id];
  log.debug('client disconnected');
};

ColabServer.prototype.on_sio_conn = function (socket) {
  var self = this;
  var number = ++self.conn_number;
  var agent_conn = new agent.SIOAgentConnection(number, socket, self);
  self.agents[number] = agent_conn;
  log.debug('socket io client', number, 'connected');
  agent_conn.once('on_conn_end', self.on_conn_end.bind(self));
};

exports.run = function () {
  log.set_log_level("debug");
  var server = new ColabServer();
  server.load_rooms(function () {
    server.listen(settings.json_port);
  });
};
