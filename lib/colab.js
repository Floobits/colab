/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";
var util = require("util");

var log = require("floorine");
var _ = require("lodash");

var poll = require("./poll");
var settings = require("./settings");


var Colab = function (controller, server_settings) {
  var self = this;

  _.each(["ip", "colab_port", "command_port", "metrics_port", "ssl", "name", "exclude"], function (key) {
    if (server_settings[key]) {
      self[key] = server_settings[key];
    }
  });

  self.id = null;
  self.memory = {};
  self.loadavg = null;

  self.controller = controller;
  self.poller = new poll.ColabPoller(self);
};

Colab.prototype.toString = function () {
  var self = this;
  return util.format("%s %s://%s:%s", (self.name || ""), (self.ssl ? "https" : "http"), self.ip, self.command_port);
};

Colab.prototype.update_workspace_counts = function (body) {
  var self = this,
    controller = self.controller;

  // Filter out current server from workspace info. Probably a better way to do this.
  _.each(controller.workspaces, function (w) {
    delete w.colabs[self.id];
  });

  _.each(body.workspaces, function (workspace) {
    var key,
      old_server,
      w;

    if (workspace.owner && workspace.name) {
      // active workspace
      key = util.format("%s/%s", workspace.owner, workspace.name);
      old_server = controller.server_mapping.workspace[key];
      if (old_server && (old_server.ip !== self.ip || old_server.colab_port !== self.colab_port)) {
        // This should never happen
        log.error("OH NO! Workspace moved from %s:%s to %s:%s", old_server.ip, old_server.colab_port, self.ip, self.colab_port);
      }
      controller.server_mapping.workspace[key] = self;
    }
    if (self.exclude) {
      return;
    }
    w = controller.workspaces[workspace.id];
    if (!w) {
      w = {
        id: workspace.id,
        colabs: {}
      };
      controller.workspaces[workspace.id] = w;
    }
    w.colabs[self.id] = {
      version: workspace.version,
      active: workspace.active
    };
  });
};


module.exports = {
  Colab: Colab
};
