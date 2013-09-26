var http = require("http");
var util = require("util");

var async = require("async");
var express = require("express");
var request = require("request");
var _ = require("lodash");

var log = require("./log");
var settings = require("./settings");

request = request.defaults({
  sendImmediately: true
});


var ColabControlServer = function () {
  var self = this;

  self.colab_stats = {};
  self.workspaces_to_servers = {};

  self.server = http.createServer(self.handle_request.bind(self));
  self.app = express();

  self.poll_interval_id = null;
};

ColabControlServer.prototype.listen = function () {
  var self = this;

  self.app.listen(settings.http_port, function (err, result) {
    if (err) {
      log.error(err);
      return;
    }

    log.log("Listening on port", settings.http_port);
  });

  self.app.get('/r/:owner/:workspace', self.handle_request.bind(self));

  self.poll_interval_id = setInterval(self.poll.bind(self), settings.poll_interval);
};

ColabControlServer.prototype.poll = function (cb) {
  var self = this;

  cb = cb || function () {};

  async.each(settings.colab_servers, function (colab_server, cb) {
    var options,
      url;

    options = {
      json: true
    };
    url = util.format("http://%s:%s/control_stats/", colab_server, settings.metric_port || 81);

    log.debug("Hitting", url);

    request.get(url, options, function (err, response, body) {
      if (err) {
        return cb(err);
      }

      log.debug("Response from", url, ":", body);

      if (response.statusCode >= 400) {
        return cb(util.format("Status code %s from %s", response.statusCode, url));
      }

      _.each(body.workspaces, function (workspace) {
        self.workspaces_to_servers[util.format("%s/%s", workspace.owner, workspace.name)] = colab_server;
      });
      self.colab_stats[colab_server] = body.memory;

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
  var self = this,
    data,
    key = util.format("%s/%s", req.params.owner, req.params.workspace),
    ip;

  ip = self.workspaces_to_servers[key];

  if (_.isUndefined(ip)) {
    // TODO: make sure this doesn't get overwritten by a poll happening right after this response
    self.workspaces_to_servers[key] = _.keys(self.colab_stats)[0];
    ip = self.workspaces_to_servers[key];
  }

  data = {
    ip: ip
  };

  res.json(200, data);
};

ColabControlServer.prototype.stop = function () {
  var self = this;

  if (_.isFinite(self.poll_interval_id)) {
    clearTimeout(self.poll_interval_id);
  }

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
