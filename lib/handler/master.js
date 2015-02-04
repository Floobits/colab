/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");
var tls = require("tls");

var async = require("async");
var fs = require("fs-extra");
var log = require("floorine");
var _ = require("lodash");

var actions = require("../actions");
var ldb = require("../ldb");
var BaseAgentHandler = require("./base");
var settings = require('../settings');
var slave = require("../slave/slave");
var utils = require("../utils");


var MasterHandler = function (protocol, auth_timeout_id) {
  var self = this;

  BaseAgentHandler.call(self, protocol, auth_timeout_id);

  self.proto_version = 0.11;
  self.server = null;
  self.perms = [
    "broadcast",
    "colab_auth",
    "create_workspace",
    "disconnect",
    "error",
    "load",
    "ping",
    "pong",
    "wallops",
    "workspaces",
  ];
  self.stats_timeout = null;
};

util.inherits(MasterHandler, BaseAgentHandler);

MasterHandler.prototype.name = "my master";

MasterHandler.prototype.auth = function (server) {
  var self = this;

  self.server = server;
  self.db = server.db;
  utils.set_state(this, this.CONN_STATES.JOINED);
  clearTimeout(this.auth_timeout_id);

  self.request("colab_auth", {
    username: settings.auth.username,
    password: settings.auth.password,
    colab_id: self.server.id,
    version: self.proto_version,
    backup: !!settings.backup,
    exclude: !!settings.exclude,
    colab_port: settings.json_port_ssl,
    api_port: settings.api_port,
  });

  this.send_stats();
};

MasterHandler.prototype.cleanup = function () {
  MasterHandler.super_.prototype.cleanup.call(this);
  this.server = null;
  this.stats_timeout = clearTimeout(this.stats_timeout);
};

MasterHandler.prototype.send_stats = function () {
  var self = this;

  async.parallel([
    self.send_workspaces.bind(self),
    self.send_load.bind(self),
  ], function (err) {
    if (err) {
      log.error(err);
    }
    self.stats_timeout = setTimeout(self.send_stats.bind(self), 10000);
  });
};

MasterHandler.prototype.send_workspaces = function (cb) {
  var self = this;

  slave.all_workspaces(self.server, function (err, workspaces) {
    if (err) {
      log.error("Error building workspace list!", err);
      return;
    }
    self.request("workspaces", { workspaces: workspaces }, cb);
  });
};

MasterHandler.prototype.send_load = function (cb) {
  var self = this;

  slave.get_load(function (err, load) {
    if (err) {
      log.error("Error getting load info!", err);
      return;
    }
    self.request("load", { data: load }, cb);
  });
};

MasterHandler.prototype.broadcast = function (data, cb) {
  this.request("broadcast", data, cb);
};

MasterHandler.prototype.on_broadcast = function (req_id, data) {
  switch (data.type) {
  case "send_to_user":
    actions.broadcast.send_to_user(data);
    break;
  case "solicit":
    actions.broadcast.solicit(data);
    break;
  default:
    log.error("unsupported broadcast", data);
    this.error(req_id, "unsupported broadcast", false);
    return;
  }
  this.ack(req_id);
};

MasterHandler.prototype.on_disconnect = function (req_id, data) {
  log.error("disconnected from master because %s.", data.reason);
  this.ack(req_id);
  this.destroy();
};

MasterHandler.prototype.on_create_workspace = function (req_id, data) {
  var self = this,
    auto = {},
    version = data.version || 0,
    workspace_id = data.id;

  auto.check_exists = function (cb) {
    self.db.get(util.format("version_%s", workspace_id), function (err, result) {
      if (!err && result) {
        return cb("already_exists");
      }
      return cb();
    });
  };
  auto.set_version = ["check_exists", function (cb) {
    self.db.put(util.format("version_%s", workspace_id), version, cb);
  }];
  auto.mkdirp = function (cb) {
    fs.mkdirs(ldb.get_db_path(workspace_id), cb);
  };
  auto.create_db = ["mkdirp", function (cb) {
    ldb.get_db(null, workspace_id, {
      createIfMissing: true,
      valueEncoding: "json"
    }, cb);
  }];
  async.auto(auto, function (err, result) {
    var msg;
    if (result.create_db) {
      ldb.finish_db(result.create_db, workspace_id);
    }
    if (err) {
      if (err === "already_exists") {
        self.error(req_id, util.format("Workspace %s already exists.", workspace_id));
        return;
      }
      msg = util.format("Error creating workspace %s: %s", workspace_id, err);
      self.error(req_id, msg);
      log.error(msg);
      return;
    }

    self.write("create_workspace", req_id, {
      workspace: {
        id: workspace_id,
        version: version,
        active: false,
      }
    });
  });
};

MasterHandler.prototype.on_wallops = function (req_id, data) {
  var self = this;
  self.server.wallops(data.data);
  self.ack(req_id);
};

MasterHandler.prototype.on_motd = function (req_id, data) {
  this.server.motd = data.data;
  this.ack(req_id);
};

module.exports = MasterHandler;
