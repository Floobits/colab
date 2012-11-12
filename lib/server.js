var events = require('events');
var fs = require('fs');
var https = require('https');
var net = require('net');
var util = require('util');

var settings = require('./settings');

var _ = require('underscore');

var agent = require('./agent');
var room = require('./room');
var log = require('./log');
var db = require('./db');

var io = require('socket.io').listen(settings.socket_io_port);
var ssl_server = https.createServer({
  key: fs.readFileSync(settings.ssl_key),
  cert: fs.readFileSync(settings.ssl_cert)
});
var io_ssl = require('socket.io').listen(ssl_server);
ssl_server.listen(settings.socket_io_port_ssl);

var ColabServer = function () {
  var self = this;
  self.conn_number = 0;
  self.agents = {};
  self.rooms = {};
};

util.inherits(ColabServer, net.Server);

ColabServer.prototype.load_rooms = function (cb) {
  var self = this;
  var query = db.client.query("SELECT room_room.id as rid, room_buffer.id as rbid, * FROM room_room LEFT OUTER JOIN room_buffer ON room_buffer.room_id = room_room.id;");
  query.on("row", function (row) {
    var r;
    log.debug(row);
    r = self.rooms[row.rid];
    if (r === undefined) {
      r = new room.Room(row.rid, row.name, row.user_id);
      r.cur_fid = row.cur_fid;
      self.rooms[row.rid] = r;
    } else {
      log.debug("room", r, "already exists");
    }
    if (row.rbid) {
      r.create_buf(row.path, row.fid, row.cur_state);
    }
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

  io_ssl.configure(function () {
    io_ssl.set('transports', settings.socket_io_transports);
    io_ssl.enable('log');
  });
  io_ssl.sockets.on('connection', self.on_sio_conn.bind(self));
};

ColabServer.prototype.on_conn = function (conn) {
  var self = this;
  var number = ++self.conn_number;
  var agent_conn = new agent.AgentConnection(number, conn, self);
  self.agents[number] = agent_conn;
  log.debug('client', number, 'connected');
  agent_conn.once('on_conn_end', self.on_conn_end.bind(self));
};

ColabServer.prototype.on_conn_end = function (agent_conn) {
  var self = this;
  if (agent_conn.room) {
    agent_conn.room.emit("dmp", agent_conn, "part", {"username": agent_conn.username});
    agent_conn.room.removeListener('dmp', agent_conn.dmp_listener);
    delete agent_conn.room.agents[agent_conn.id];
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
