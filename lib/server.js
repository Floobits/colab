var fs = require("fs");
var http = require("http");
var https = require("https");
var util = require("util");

var async = require("async");
var express = require("express");
var log = require("floorine");
var request = require("request");
var _ = require("lodash");

var settings = require("./settings");

request = request.defaults({
  sendImmediately: true
});


var ColabControlServer = function () {
  var self = this;

  self.server_mapping = {
    "token": {},
    "workspace": {},
    "username": {}
  };

  self.colab_servers = _.clone(settings.colab_servers);

  self.app = express();
  self.poll_interval_id = null;

  /*jslint stupid: true */
  if (settings.https_port) {
    self.cert = fs.readFileSync(settings.ssl_cert);
    self.key = fs.readFileSync(settings.ssl_key);
    if (settings.ssl_ca) {
      self.ca = [];
      _.each(settings.ssl_ca, function (filename) {
        self.ca.push(fs.readFileSync(filename));
      });
    }
  }
  /*jslint stupid: false */

  if (settings.https_port) {
    log.log("HTTPS enabled on port", settings.https_port);
    self.server_ssl = https.createServer({
      ca: self.ca,
      cert: self.cert,
      key: self.key
    }, self.app);
  }

  self.server = http.createServer(self.app);
  self.app.get('/r/:owner/:workspace', self.handle_workspace_request.bind(self));
  self.app.get('/t/:token', self.handle_request.bind(self, "token"));
  self.app.get('/u/:username', self.handle_request.bind(self, "username"));
};

ColabControlServer.prototype.listen = function () {
  var self = this;

  self.server.listen(settings.http_port, function (err, result) {
    if (err) {
      log.error(err);
      return;
    }
    log.log("Listening on port", settings.http_port);
  });

  if (self.server_ssl) {
    self.server_ssl.listen(settings.https_port, function (err, result) {
      if (err) {
        log.error(err);
        return;
      }
      log.log("Listening on port", settings.https_port);
    });
  }

  log.log("Polling every", settings.poll_interval, "seconds");
  self.poll_interval_id = setInterval(self.poll.bind(self), settings.poll_interval);
};

ColabControlServer.prototype.poll = function (cb) {
  var self = this;

  cb = cb || function () {};

  async.each(self.colab_servers, function (colab_server, cb) {
    var options = {
        json: true
      },
      url = util.format("http://%s:%s/control_stats/", colab_server.ip, colab_server.metrics_port);

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
        var key = util.format("%s/%s", workspace.owner, workspace.name),
          old_server = self.server_mapping.workspace[key];

        if (old_server && (old_server.ip !== colab_server.ip || old_server.colab_port !== colab_server.colab_port)) {
          // This should never happen
          log.error(util.format("Workspace moved from %s:%s to %s:%s", old_server.ip, old_server.port, colab_server.ip, colab_server.port));
        }
        self.server_mapping.workspace[key] = colab_server;
      });

      _.extend(colab_server, body);
      cb(err, response);
    });
  }, function (err, result) {
    if (err) {
      log.error("Error polling colab servers:", err);
    }
    cb(err, result);
  });
};

ColabControlServer.prototype.find_server = function (namespace, key) {
  var self = this,
    colab_server = self.server_mapping[namespace][key],
    servers;

  if (colab_server) {
    log.debug("%s %s is on %s:%s", namespace, key, colab_server.ip, colab_server.colab_port);
    return {
      ip: colab_server.ip,
      port: colab_server.colab_port,
      ssl: colab_server.ssl
    };
  }

  servers = _.chain(self.colab_servers)
    .filter(function (server) { return !server.exclude; })
    .shuffle()
    .value();

  colab_server = _.find(servers, function (server) {
    var mem_free = server.memory.freemem / server.memory.totalmem,
      rss_used = server.memory.rss / server.memory.totalmem;
    return _.max(server.loadavg) < 0.5 && mem_free > 0.3 && rss_used < 0.7;
  });

  // Nothing good. just pick one
  if (colab_server) {
    log.debug("Picked %s:%s for %s %s", colab_server.ip, colab_server.colab_port, namespace, key);
  } else {
    log.warn("All servers are busy. Picking one at random.");
    colab_server = servers[0];
    log.debug("Randomly picked %s:%s for %s %s", colab_server.ip, colab_server.colab_port, namespace, key);
  }

  self.server_mapping[namespace][key] = colab_server;

  return {
    ip: colab_server.ip,
    port: colab_server.colab_port,
    ssl: colab_server.ssl
  };
};

ColabControlServer.prototype.handle_request = function (namespace, req, res) {
  var self = this,
    data = self.find_server(namespace, req.params[namespace]);

  log.debug(data);
  res.json(200, data);
};

ColabControlServer.prototype.handle_workspace_request = function (req, res) {
  var self = this,
    data,
    key = util.format("%s/%s", req.params.owner, req.params.workspace);

  data = self.find_server("workspace", key);

  res.json(200, data);
};

ColabControlServer.prototype.stop = function () {
  var self = this;

  if (_.isFinite(self.poll_interval_id)) {
    clearTimeout(self.poll_interval_id);
  }

  try {
    log.log("Closing HTTP server...");
    self.server.close();
    log.log("Done closing HTTP server.");
  } catch (e) {
    log.error("Error closing HTTP server:", e);
  }

  if (self.server_ssl) {
    try {
      log.log("Closing HTTPS server...");
      self.server_ssl.close();
      log.log("Done closing HTTPS server.");
    } catch (e2) {
      log.error("Error closing HTTPS server:", e2);
    }
  }
};


exports.run = function () {
  var self = this,
    server;

  log.set_log_level(settings.log_level);

  server = new ColabControlServer();

  function shut_down(sig) {
    log.log("caught signal: ", sig);
    server.stop();
    process.exit(0);
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
    log.log("Starting to listen on port", settings.http_port);
    server.listen();
  });
};
