
var net = require('net');

var server = net.createServer(function(c) {
  console.log('server connected');
  c.on('end', function() {
    console.log('server disconnected');
  });
  c.on('data', function(d){
    console.log(d.toString());
  });
  c.pipe(c);
});
server.listen(3148);