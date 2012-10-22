
var util = require('util');
var events = require('events');

var _ = require('underscore');

var ColabBuffer = require('./buffer');
var createRoom = require('./room').create;
var log = require('./log');

var SUPPORTED_VERSIONS = ['0.01'];


var AgentConnection = function(id, conn, server){
  var self = this;

  events.EventEmitter.call(self);

  self.id = id;
  self.conn = conn;
  self._bufs = [];
  self.authenticated = false;
  self.room = undefined;
  self.user = undefined;
  self.server = server;
  self.auth_timeout = 10000;

  // wire events
  conn.on('end', function(){
    // do we need to remove the room listener?
    self.emit('on_conn_end', self);
  });
  conn.on('connect', function () {
    self.buf = "";
    setTimeout(self.disconnect_unauthed_client.bind(self), self.auth_timeout);
  });
  conn.on('data', self.on_data.bind(self));

  // internal events
  self.on('request', self.on_request.bind(self));
  self.on('dmp', function(){
    if (!self._room){
      return;
    }
    self._room.emit.call(arguments);
  });
};

util.inherits(AgentConnection, events.EventEmitter);

AgentConnection.prototype.disconnect_unauthed_client = function(){
  var self = this;
  if (self.authenticated === true) {
    log.debug("client authed before timeout");
  } else {
    log.log("client took too long to auth. disconnecting");
    self.conn.destroy();
  }
};

AgentConnection.prototype.join_room = function(name){
  var self = this;
  var room = createRoom(name, self, '777');
  self._room = room;
};

AgentConnection.prototype.send_dmp = function(dmp){
  var self = this;
  if (self.conn){
    self.conn.write(dmp);
  }
};

AgentConnection.prototype.on_data = function(d){
  var self = this;
  var msg;
  var auth_data;

  log.debug("d: " + d);

  self.buf += d;
  if (self.buf.indexOf("\n") === -1){
    log.debug("buf has no newline");
    return;
  }

  msg = self.buf.split("\n", 2);
  self.buf = msg[1];
  msg = msg[0];

  if (self.authenticated) {
    self.emit('request', msg);
  } else {
    auth_data = JSON.parse(msg);
    if (_.has(auth_data, "username") &&
        _.has(auth_data, "secret") &&
        _.has(auth_data, "room") &&
        _.has(auth_data, "version")) {
      if (!_.contains(SUPPORTED_VERSIONS, auth_data.version)){
        log.log("unsupported client version. disconnecting");
        self.conn.destroy();
        return;
      }

      self.username = auth_data.username;
      self.secret = auth_data.secret;
      self.room = auth_data.room;

      if (!_.has(self.server.rooms, auth_data.room)) {
        self.server.rooms[auth_data.room] = {
          agents: {},
          bufs: {}
        };
      }
      self.room = self.server.rooms[auth_data.room];
      self.room.agents[self.id] = self;
      self.bufs = self.room.bufs;
      /* todo: actually auth against something */
      self.authenticated = true;
      log.debug("client authenticated. yay!");
    } else {
      log.log("bath auth json. disconnecting client");
      /* TODO: cancel interval for disconnect_unauthed_client */
      self.conn.destroy();
      return;
    }
  }
};

AgentConnection.prototype.on_request = function(raw){
  var self = this;
  var buf;
  var req = JSON.parse(raw);

  /*
  // Interim hack
  _.each(self.room.agents, function (v, k) {
    log.debug("agent", v.id, "self", self.id);
    if (v.id === self.id) {
      return;
    }
    v.conn.write(raw + "\n");
  });
*/
  if (!req.path) {
    log.log("bad client: no path. goodbye");
    return self.conn.destroy();
  }

  buf = self.bufs[req.path];
  if (buf) {
    buf.emit(req.path, req);
  } else {
    buf = new ColabBuffer(self, req.path, req.patch);
    self.bufs[buf.path] = buf;
  }
};

AgentConnection.prototype.on_dmp = function(json){
  var str = JSON.dumps(json) + '\n';
  var str_len = str.length;
  var str_str_len = toString(str_len);
  while (str_str_len.length < LENGTH_PREFIX){
    str_str_len = '0' + str_str_len;
  }
  self.conn.write(str_str_len + str);
};

module.exports = AgentConnection;
