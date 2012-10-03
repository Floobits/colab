
var net = require('net');
var util = require('util');
var events = require('events');
var crypto = require('crypto');
var DMP = new require('diff_match_patch').diff_match_patch();

var _ = require('underscore');

var LENGTH_PREFIX = 20;

var ColabServer = function(){
  var self = this;
  self.number = 0;
  self.agents = {};
  self.channels = {};
};

util.inherits(ColabServer, net.Server);

ColabServer.prototype.listen = function(port, address){
  var self = this;
  net.Server.call(self, self.on_conn.bind(self));
  net.Server.prototype.listen.call(self, port, address);
  console.log('now listening on port: ' + port);
};

ColabServer.prototype.on_conn = function(conn){
  var self = this;
  var number = ++self.conn_number;
  var agent = new AgentConnection(number, conn, self);
  self.agents[number] = number;
  agent.once('on_conn_end', self.on_conn_end.bind(self));
};

ColabServer.prototype.on_conn_end = function(agent){
  var self = this;
  delete self.agents[agent.id];
  console.log('server disconnected');
};

ColabServer.prototype.broadcast = function(room, dpm){
  var self = this;
  _.each(self.agents, function(agent){
    if (agent.attending(room)){
      agent.send_dmp(dpm);
    }
  });
};

var ColabBuffer = function(agent, uid, name){
  var self = this;
  self.guid = util.format("%s-%s", agent.id, uid);
  self.state = "";
  self.checksum = null;
  self.is_valide = true;
};
util.inherits(ColabBuffer, events.EventEmitter);

ColabBuffer.prototype.on_dmp = function(patches, checksum){
  DMP.patch_apply(patches, self.state);
  var hash = crypto.createHash('md5').update(self.state);

  if (hash.digest("hex") !== checksum){
    // TODO- tell client to resend whole damn file
    self.is_valide = false;
    return;
  }
  self.checksum = checksum;
  self.emit('dmp', patches, checksum);
};

var AgentConnection = function(id, conn, server){
  var self = this;
  self.id = id;
  self.conn = conn;
  self.server = self;
  self.buf = "";
  self.rooms = [];
  self.
  conn.on('end', function(){
    self.emit('on_conn_end', self);
  });
  conn.on('data', self.on_data.bind(self));
  self.on('requst', self.on_request.bind(self));
  events.EventEmitter.call(self);
};

AgentConnection.supported_versions = ['0.01'];

util.inherits(AgentConnection, events.EventEmitter);

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
  raw = raw.slice(LENGTH_PREFIX);
  if (raw.indexOf("\n") === -1) {
    return;
  }
  json = JSON.parse(raw);
  if (!json.v || !_.has(self.supported_versions, json.v)){
    self.conn.destroy();
    return;
  }

  console.log(json);
};

AgentConnection.prototype.on_dmp = function(event){

};
server.listen(3148);
