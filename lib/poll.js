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


var ColabPoller = function (server, interval) {
  var self = this;

  self.server = server;
  self.interval = interval;
  self.interval_id = null;
};


ColabPoller.prototype.start = function () {
  var self = this;

  log.log("Polling every", self.interval / 1000, "seconds");
  self.interval_id = setInterval(self.poll.bind(self), self.interval);
};


ColabPoller.prototype.stop = function () {
  var self = this;

  log.log("Stopping polling...");
  if (self.interval_id) {
    clearTimeout(self.interval_id);
    self.interval_id = null;
    log.log("Stopped polling.");
  } else {
    log.warn("No polling to stop!");
  }
};


ColabPoller.prototype.poll = function (cb) {
  var self = this;

  cb = cb || function (err) {
    if (err) {
      log.error(err);
    }
  };

  async.each(self.server.colab_servers, function (colab_server, cb) {
    var options = {
        json: true,
        rejectUnauthorized: false
      },
      url = util.format("%s://%s:%s/workspaces/all/", "http", colab_server.ip, colab_server.metrics_port);

    log.debug("Hitting", url);

    request.get(url, options, function (err, response, body) {
      if (err) {
        return cb(err);
      }

      // log.debug("Response from", url, ":", body);
      log.debug("Got response from %s", url);

      if (response.statusCode >= 400) {
        return cb(util.format("Status code %s from %s", response.statusCode, url));
      }

      // Filter out current server from workspace info. Probably a better way to do this.
      _.each(self.server.workspaces, function (w) {
        delete w.servers[colab_server.id];
      });

      _.each(body, function (workspace) {
        var key,
          old_server,
          w;

        if (workspace.owner && workspace.name) {
          // active workspace
          key = util.format("%s/%s", workspace.owner, workspace.name);
          old_server = self.server.server_mapping.workspace[key];
          if (old_server && (old_server.ip !== colab_server.ip || old_server.colab_port !== colab_server.colab_port)) {
            // This should never happen
            log.error("OH NO! Workspace moved from %s:%s to %s:%s", old_server.ip, old_server.port, colab_server.ip, colab_server.port);
          }
          self.server.server_mapping.workspace[key] = colab_server;
        }
        if (colab_server.exclude) {
          return;
        }
        w = self.server.workspaces[workspace.id];
        if (!w) {
          w = {
            id: workspace.id,
            servers: {}
          };
          self.server.workspaces[workspace.id] = w;
        }
        w.servers[colab_server.id] = {
          version: workspace.version,
          active: workspace.active
        };
      });
      return cb(err, response);
    });
  }, function (err, result) {
    var actions = [],
      stats = {
        high: 0,
        low: 0,
        correct: 0
      };
    if (err) {
      log.error("Error polling colab servers:", err);
      // TODO: don't die here. Mark the server bad or something.
      process.exit(1);
    }
    log.debug(self.server.workspaces);
    _.each(self.server.workspaces, function (w, id) {
      var repcount = _.size(w.servers);
      if (repcount < settings.repcount) {
        stats.low++;
        log.debug("Workspace %s has %s replicas (not enough).", id, repcount);
        // TODO: favor server with the most disk used
        actions.push(function () {
          self.server.delete_workspace_by_id(_.shuffle(w.servers)[0], id);
        });
      } else if (repcount > settings.repcount) {
        stats.high++;
        log.debug("Workspace %s has %s replicas (too many).", id, repcount);
      } else {
        stats.correct++;
        log.debug("Workspace %s has the correct number of replicas (%s)", id, repcount);
      }
    });
    log.log("Workspace replication counts: %s low. %s high. %s correct.", stats.low, stats.high, stats.correct);
    cb(err, result);
  });
};

module.exports = {
  ColabPoller: ColabPoller
};
