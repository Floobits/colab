
var util = require('util');
var events = require('events');

var _ = require('underscore');

var ColabBuffer = require('./buffer');
var createRoom = require('./room').create;

var SUPPORTED_VERSIONS = ['0.01'];


var AgentConnection = function(id, conn, room){
  var self = this;

  events.EventEmitter.call(self);

  self.id = id;
  self.conn = conn;
  self._bufs = [];
  self.room = room;
  // wire events
  conn.on('end', function(){
    // do we need to remove the room listener?
    self.emit('on_conn_end', self);
  });
  conn.on('connect', function () {
    self.buf = "";
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

  console.log("d: " + d);

  self.buf += d;
  if (self.buf.indexOf("\n") === -1){
    console.log("buf has no newline");
    return;
  }

  msg = self.buf.split("\n", 2);
  self.buf = msg[1];
  msg = msg[0];

  _.each(self.room.agents, function (v, k) {
    console.log("agent" + v.id + " self " + self.id);
    if (v.id === self.id) {
      return;
    }
    v.conn.write(msg + "\n");
  });
//  self.emit('request', msg);
};

AgentConnection.prototype.on_request = function(raw){
  var self = this;
  var req, buf;
  console.log(raw);
  req = JSON.parse(raw);
  if (!req.v || !_.has(SUPPORTED_VERSIONS, req.v)){
    console.log("bad client. goodbye");
//    return self.conn.destroy();
  }

  if (!req.event.uid){
    console.log("bad client: no event uid. goodbye");
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
