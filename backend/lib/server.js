var net = require('net');
var util = require('util');
var events = require('events');

var settings = require('./settings');

var _ = require('underscore');
var io = require('socket.io').listen(settings.socket_io_port);

var agent = require('./agent');
var AgentConnection = agent.AgentConnection;
var SIOAgentConnection = agent.SIOAgentConnection;
var log = require('./log');


var ColabServer = function () {
  var self = this;
  self.conn_number = 0;
  self.agents = {};
  self.rooms = {};
};

util.inherits(ColabServer, net.Server);

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
  var agent = new AgentConnection(number, conn, self);
  self.agents[number] = agent;
  log.debug('client', number, 'connected');
  agent.once('on_conn_end', self.on_conn_end.bind(self));
};

ColabServer.prototype.on_conn_end = function (agent) {
  var self = this;
  if (agent.room) {
    agent.room.removeListener('dmp', agent.dmp_listener);
    delete agent.room.agents[agent.id];
  }
  delete self.agents[agent.id];
  log.debug('client disconnected');
};

ColabServer.prototype.on_sio_conn = function (socket) {
  var self = this;
  var number = ++self.conn_number;
  var agent = new SIOAgentConnection(number, socket, self);
  self.agents[number] = agent;
  log.debug('socket io client', number, 'connected');
  agent.once('on_conn_end', self.on_conn_end.bind(self));

//  socket.emit('news', { hello: 'world' });
/*  socket.on('patch', function (data) {
    console.log(data);
  });*/
};

exports.run = function () {
  log.set_log_level("debug");
  new ColabServer().listen(settings.json_port);
};
