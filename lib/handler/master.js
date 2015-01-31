/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");
var tls = require("tls");

var async = require("async");
var fs = require("fs-extra");
var log = require("floorine");
var _ = require("lodash");

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

MasterHandler.prototype.write = function (name, req_id, json, cb) {
  var self = this;

  if (self.state < self.CONN_STATES.JOINED) {
    log.warn("client %s: Discarding event %s because conn state is %s", self.toString(), name, self.state);
    return cb && cb();
  }

  if (self.state >= self.CONN_STATES.DESTROYED) {
    log.error("Somebody called write after we destroyed connection %s!", self.id);
    log.error("Event: %s", name);
    console.trace();
    return cb && cb();
  }

  json.name = name;

  if (req_id) {
    self.protocol.respond(req_id, json, cb);
  } else {
    self.protocol.request(json, cb);
  }
};

MasterHandler.prototype.auth = function (server) {
  var self = this;

  self.server = server;
  utils.set_state(this, this.CONN_STATES.JOINED);
  clearTimeout(this.auth_timeout_id);

  self.write("colab_auth", null, {
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

MasterHandler.prototype.send_stats = function () {
  var self = this;

  async.parallel([
    self.send_workspaces.bind(self),
    self.send_load.bind(self),
  ], function (err) {
    if (err) {
      log.error(err);
    }
    self.stats_timeout = setTimeout(self.send_stats.bind(self), 30000);
  });
};

MasterHandler.prototype.send_workspaces = function (cb) {
  var self = this;

  slave.all_workspaces(self.server, function (err, workspaces) {
    if (err) {
      log.error("Error building workspace list!", err);
      return;
    }
    self.write("workspaces", null, { workspaces: workspaces }, cb);
  });
};

MasterHandler.prototype.send_load = function (cb) {
  var self = this;

  slave.get_load(function (err, load) {
    if (err) {
      log.error("Error getting load info!", err);
      return;
    }
    self.write("load", null, { data: load }, cb);
  });
};

MasterHandler.prototype.on_create_workspace = function (req_id, data) {
  var self = this,
    auto = {},
    version = data.version || 0,
    workspace_id = data.id;

  auto.check_exists = function (cb) {
    self.server.db.get(util.format("version_%s", workspace_id), function (err, result) {
      if (!err && result) {
        return cb("already_exists");
      }
      return cb();
    });
  };
  auto.set_version = ["check_exists", function (cb) {
    self.server.db.put(util.format("version_%s", workspace_id), version, cb);
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

MasterHandler.prototype.on_wallops = function(req_id, data) {
  this.server.wallops = data.wallops;
  this.ack(req_id);
};

MasterHandler.prototype.on_motd = function(req_id, data) {
  this.server.motd = data.motd;
  this.ack(req_id);
};
module.exports = MasterHandler;
