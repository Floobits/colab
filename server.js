
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
    var msg;
    console.log("d: " + d);
    buf += d;
    console.log("buf: " + buf);
    if (buf.indexOf("\n") === -1) {
      return;
    }
    msg = buf.split("\n", 2);
    buf = msg[1];
    msg = msg[0];
    console.log("msg: ", msg);
    _.each(active_conns, function(conn, id){
      if (id === number){
        return;
      }
      conn.write(msg + "\n");
    });
  });
});
server.listen(3148);
