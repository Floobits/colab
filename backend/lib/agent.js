
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

AgentConnection.prototype.attending = function(room){
  // easy and slow!
  var self = this;
  return _.has(self.rooms, room);
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
      _.each(self.room.agents, function (v, k) {
        log.debug("agent" + v.id + " self " + self.id);
        if (v.id === self.id) {
          return;
        }
        v.conn.write(msg + "\n");
      });
    //  self.emit('request', msg);
  } else {
    auth_data = JSON.parse(msg);
    if (_.has(auth_data, "username") &&
        _.has(auth_data, "secret") &&
        _.has(auth_data, "room")) {
      self.username = auth_data.username;
      self.secret = auth_data.secret;
      self.room = auth_data.room;
      /* todo: actually auth against something */
      self.authenticated = true;
      log.debug("client authenticated. yay!");
    } else {
      log.log("bath auth json. disconnecting client");
      /* TODO: cancel interval for disconnect_unauthed_client */
      self.conn.destroy();
    }
  }
};

AgentConnection.prototype.on_request = function(raw){
  var self = this;
  var req, buf;
  log.debug(raw);
  req = JSON.parse(raw);
  if (!req.v || !_.has(SUPPORTED_VERSIONS, req.v)){
    log.log("bad client. goodbye");
//    return self.conn.destroy();
  }

  if (!req.event.uid){
    log.log("bad client: no event uid. goodbye");
//    return self.conn.destroy();
  }

  buf = self.colab_bufs[req.event.uid];
  if (buf){
    return buf.emit(req.event, req);
  }

  buf = new ColabBuffer(self, req.uid, req.name, req.patches);

  self.colab_bufs[buf.uid] = buf;
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
