
var util = require('util');
var events = require('events');

var _ = require('underscore');

var ColabBuffer = require('./buffer');
var createRoom = require('./room').create;

var LENGTH_PREFIX = 20;
var SUPPORTED_VERSIONS = ['0.01'];


var AgentConnection = function(id, conn, room){
  var self = this;

  events.EventEmitter.call(self);

  self.id = id;
  self.conn = conn;
  self._bufs = [];
  // wire events
  conn.on('end', function(){
    // do we need to remove the room listener?
    self.emit('on_conn_end', self);
  });
  conn.on('data', self.on_data.bind(self));

  // internal events
  self.on('requst', self.on_request.bind(self));
  self.on('dmp', function(){
    if (!self._room){
      return;
    }
    self._room.emit.call(arguments);
  });
};

util.inherits(AgentConnection, events.EventEmitter);

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
  var length_chars, length, msg;

  console.log("d: " + d);

  self.buf += d;

  if (self.buf.length < LENGTH_PREFIX){
    console.log("getting prefix: buf is only " + self.buf.length + " bytes");
    return;
  }

  length_chars = parseInt(self.buf.slice(0, LENGTH_PREFIX), 10);
  if (self.buf.length < length_chars + LENGTH_PREFIX) {
    console.log("getting msg: buf is only " + self.buf.length + " bytes. want " + length_chars + LENGTH_PREFIX + " bytes");
    return;
  }

  msg = self.buf.slice(LENGTH_PREFIX, length_chars+LENGTH_PREFIX);
  self.emit('request', msg);
  self.buf = self.buf.slice(length_chars+LENGTH_PREFIX);
};

AgentConnection.prototype.on_request = function(raw){
  var self = this;
  var req, buf;
  raw = raw.slice(LENGTH_PREFIX);
  if (raw.indexOf("\n") === -1) {
    return;
  }
  req = JSON.parse(raw);
  if (!req.v || !_.has(SUPPORTED_VERSIONS, req.v)){
    return self.conn.destroy();
  }

  if (!req.event.uid){
    return self.conn.destroy();
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