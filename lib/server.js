var events = require('events');
var fs = require('fs');
var https = require('https');
var net = require('net');
var tls = require('tls');
var util = require('util');

var settings = require('./settings');

var _ = require('underscore');

var agent = require('./agent');
var room = require('./room');
var log = require('./log');
var db = require('./db');

var ColabServer = function () {
  var self = this;
  self.conn_number = 0;
  self.agents = {};
  self.rooms = {};
  self.server = net.createServer(self.on_conn.bind(self));

  if (settings.json_port_ssl || settings.socket_io_port_ssl) {
    self.cert = fs.readFileSync(settings.ssl_cert);
    self.key = fs.readFileSync(settings.ssl_key);
  }

  if (settings.json_port_ssl) {
    log.debug("json ssl enabled");
    self.server_ssl = tls.createServer({
      cert: self.cert,
      key: self.key
    }, self.on_conn.bind(self));
  }

  if (settings.socket_io_port_ssl) {
    log.debug("socket.io ssl enabled");
    self.https_server = https.createServer({
      cert: self.cert,
      key: self.key
    });
  }
};

ColabServer.prototype.load_rooms = function (cb) {
  var self = this;
  var query = db.client.query("SELECT room_room.id as rid, room_buffer.id as rbid, * FROM room_room LEFT OUTER JOIN room_buffer ON room_buffer.room_id = room_room.id;");
  query.on("row", function (row) {
    var r;
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
  query.on("end", function (result) {
    cb(null, result);
  });
  query.on("error", cb);
};

ColabServer.prototype.listen = function () {
  var self = this;
  self.server.listen(settings.json_port);
  log.log('JSON protocol listening on port', settings.json_port);

  if (self.server_ssl) {
    self.server_ssl.listen(settings.json_port_ssl);
    log.log('JSON SSL protocol listening on port', settings.json_port_ssl);
  }

  self.io = require('socket.io').listen(settings.socket_io_port);
  self.io.configure(function () {
    self.io.enable('browser client minification');
    self.io.enable('browser client etag');
    self.io.enable('browser client gzip');
    self.io.enable('log');
    self.io.set('transports', settings.socket_io_transports);
    self.io.set('log level', 2);
  });
  self.io.sockets.on('connection', self.on_sio_conn.bind(self));
  log.log('Socket.io protocol listening on port', settings.socket_io_port);

  if (self.https_server) {
    self.io_ssl = require('socket.io').listen(self.https_server);
    self.https_server.listen(settings.socket_io_port_ssl);

    log.debug("configuring sio ssl");
    self.io_ssl.configure(function () {
      self.io_ssl.enable('browser client minification');
      self.io_ssl.enable('browser client etag');
      self.io_ssl.enable('browser client gzip');
      self.io_ssl.enable('log');
      self.io_ssl.set('transports', settings.socket_io_transports);
      self.io_ssl.set('log level', 2);
    });
    self.io_ssl.sockets.on('connection', self.on_sio_conn.bind(self));
    log.log('Socket.io SSL protocol listening on port', settings.socket_io_port_ssl);
  }
};

ColabServer.prototype.on_conn = function (conn) {
  var self = this;
  var number = ++self.conn_number;
  var agent_conn = new agent.AgentConnection(number, conn, self);
  self.agents[number] = agent_conn;
  log.debug('client', number, 'connected from', conn.remoteAddress, ':', conn.remotePort);
  agent_conn.once('on_conn_end', self.on_conn_end.bind(self));
};

ColabServer.prototype.on_conn_end = function (agent_conn) {
  var self = this;
  if (agent_conn.room) {
    agent_conn.room.emit("dmp", agent_conn, "part", {"user_id": agent_conn.id, "username": agent_conn.username});
    agent_conn.room.removeListener('dmp', agent_conn.dmp_listener);
    delete agent_conn.room.agents[agent_conn.id];
  }
  delete self.agents[agent_conn.id];
  log.debug('client', agent_conn.id, 'disconnected');
};

ColabServer.prototype.on_sio_conn = function (socket) {
  var self = this;
  var number = ++self.conn_number;
  var agent_conn = new agent.SIOAgentConnection(number, socket, self);
  self.agents[number] = agent_conn;
  log.debug('socket io client', number, 'connected from', socket.handshake.address.address, ':', socket.handshake.address.port);
  agent_conn.once('on_conn_end', self.on_conn_end.bind(self));
};

exports.run = function () {
  log.set_log_level("debug");
  var server = new ColabServer();
  server.load_rooms(function (err, result) {
    if (err) {
      log.error("Error loading rooms:", err);
      process.exit(1);
    }
    server.listen();
  });
};
