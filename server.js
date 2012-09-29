
var net = require('net');

var _ = require('underscore');

var active_conns = {};
var conn_number = 0;
var LENGTH_PREFIX = 20;

var server = net.createServer(function(c) {
  var number = ++conn_number;
  var has_authed = false;
  var buf = "";
  
  active_conns[number] = c;

  console.log('server connected');

  c.on('end', function() {
    delete active_conns[number];
    console.log('server disconnected');
  });

  c.on('data', function(d){
    var length_chars, length, msg;
    buf += d;
    if (buf.length < LENGTH_PREFIX){
      return;
    }
    length_chars = buf.slice(0, LENGTH_PREFIX);
    if (buf.length < length_chars + LENGTH_PREFIX){
      return;
    }
    msg = buf.slice(0, length_chars+LENGTH_PREFIX);
    buf = buf.slice(length_chars+LENGTH_PREFIX);
    console.log(msg);
    _.each(active_conns, function(conn, id){
      if (id === number){
        return;
      }
      conn.write(msg);
    });
  });
});
server.listen(3148);