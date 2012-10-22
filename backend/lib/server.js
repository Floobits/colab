var net = require('net');
var util = require('util');
var events = require('events');

var _ = require('underscore');

var AgentConnection = require('./agent');
var log = require('./log');

var ColabServer = function() {
  var self = this;
  self.conn_number = 0;
  self.agents = {};
  self.rooms = {};
};

util.inherits(ColabServer, net.Server);

ColabServer.prototype.listen = function(port, address) {
  var self = this;
  net.Server.call(self, self.on_conn.bind(self));
  net.Server.prototype.listen.call(self, port, address);
  log.log('Listening on port ' + port);
};

ColabServer.prototype.on_conn = function(conn) {
  var self = this;
  var number = ++self.conn_number;
  var agent = new AgentConnection(number, conn, self);
  self.agents[number] = agent;
  log.debug('client', number, 'connected');
  agent.once('on_conn_end', self.on_conn_end.bind(self));
};

ColabServer.prototype.on_conn_end = function(agent) {
  var self = this;
  delete self.agents[agent.id];
  log.debug('client disconnected');
};

exports.run = function() {
  log.set_log_level("debug");
  new ColabServer().listen(3148);
};
