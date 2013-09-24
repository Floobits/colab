var http = require("http");
var util = require("util");

var async = require("async");
var request = require("request");
var _ = require("lodash");

var log = require("./log");
var settings = require("./settings");

request = request.defaults({
  sendImmediately: true
});


var ColabControlServer = function () {
  var self = this;

  self.stats = {};
  self.workspaces = {};

  self.server = http.createServer(self.handle_request.bind(self));
};

ColabControlServer.prototype.listen = function () {
  var self = this;

  self.server.listen(settings.http_port, function (err, result) {
    if (err) {
      log.error(err);
    }
  });
};

ColabControlServer.prototype.poll = function (cb) {
  var self = this;

  async.each(settings.colab_servers, function (colab_server, cb) {
    var url = util.format("http://%s:%s/control_stats/", colab_server, 8081);

    log.debug("Hitting", url);

    request.get(url, function (err, response, body) {
      cb(err, response);
    });
  }, function (err, result) {
    if (err) {
      log.error("Error polling colab servers:", err);
    }
    cb(err, result);
  });
};

ColabControlServer.prototype.handle_request = function (req, res) {
  var self = this;

  res.end();
};

ColabControlServer.prototype.stop = function () {
  var self = this;

  log.log("Closing server...");
  self.server.close();
  log.log("Done closing server.");
};


exports.run = function () {
  var self = this,
    server;

  log.set_log_level(settings.log_level);

  server = new ColabControlServer();

  function shut_down(sig) {
    log.log("caught signal: ", sig);
    server.stop();
  }

  process.on("SIGTERM", function () {shut_down("SIGTERM"); });
  process.on("SIGINT", function () {shut_down("SIGINT"); });

  process.on("SIGHUP", function (sig) {
    delete require.cache[require.resolve("./settings")];
    settings = require("./settings");
  });

  log.log("Polling servers...");
  server.poll(function (err, result) {
    if (err) {
      process.exit(1);
    }
    log.log("Listening on port", settings.http_port);
    server.listen();
  });

};
