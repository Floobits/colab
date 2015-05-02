"use strict";

const tls = require("tls");
const util = require("util");

const log = require("floorine");
const _ = require("lodash");

const actions = require("../actions");
const BaseAgentHandler = require("./base");
const VirtualAgent = require("./virtual");
const ReplicationServerHandler = require("./replication_server");
const FlooProtocol = require("../protocol/floobits");
const settings = require("../settings");
const slave = require("../slave/slave");
const utils = require("../utils");


const MasterHandler = function () {
  BaseAgentHandler.apply(this, arguments);

  this.proto_version = 0.11;
  this.server = null;
  this.perms = [
    "broadcast",
    "slave",
    "disconnect",
    "error",
    "load",
    "motd",
    "ping",
    "pong",
    "wallops",
    "workspaces",
    "workspace",
  ];
  this.stats_timeout = null;

  actions.room.onADD(this.send_workspace, this);
  actions.room.onUPDATE(this.send_workspace, this);
  actions.room.onDELETE(function (workspace_id) {
    if (!this.server) {
      return;
    }
    this.request("workspace", {
      action: "delete",
      data: {
        id: workspace_id,
      },
    });
  }, this);
};

util.inherits(MasterHandler, BaseAgentHandler);

MasterHandler.prototype.name = "my master";

MasterHandler.prototype.auth = function (server) {
  var self = this;

  self.server = server;
  self.db = server.db;
  utils.set_state(this, this.CONN_STATES.JOINED);
  clearTimeout(this.auth_timeout_id);

  self.request("slave", {
    action: "auth",
    username: settings.auth.username,
    password: settings.auth.password,
    colab_id: self.server.id,
    version: self.proto_version,
    backup: !!settings.backup,
    exclude: !!settings.exclude,
    colab_port: settings.json_port_ssl,
    api_port: settings.api_port,
  });

  self.send_load();
  self.send_workspaces(function (err) {
    if (err) {
      log.error(err);
    }
  });
};

MasterHandler.prototype.destroy = function () {
  MasterHandler.super_.prototype.destroy.call(this);
  this.server = null;
  this.stats_timeout = clearTimeout(this.stats_timeout);
};

MasterHandler.prototype.send_workspace = function (workspace_id, workspace) {
  if (!this.server) {
    return;
  }
  this.request("workspace", {
    action: "update",
    data: workspace.to_master_json(),
  });
};

MasterHandler.prototype.send_workspaces = function (cb) {
  var self = this;

  slave.all_workspaces(self.server, function (err, workspaces) {
    if (err) {
      log.error("Error building workspace list!", err);
      return;
    }
    self.request("workspaces", { action: "set", workspaces: workspaces }, cb);
  });
};

MasterHandler.prototype.send_load = function () {
  var self = this;

  slave.get_load(function (err, load) {
    if (err) {
      log.error("Error getting load info!", err);
      return;
    }
    self.request("load", { action: "set", data: load }, function (load_err) {
      if (load_err) {
        log.error(load_err);
      }
      self.stats_timeout = setTimeout(self.send_load.bind(self), 10000);
    });
  });
};

MasterHandler.prototype.fetch_workspace = function (workspace_id, data, cb) {
  var self = this,
    conn_options = {
      host: data.ip,
      port: data.port,
    };

  log.log("Fetching %s from %s:%s", workspace_id, data.ip, data.port);

  let protocol = new FlooProtocol(++self.server.conn_number);
  try {
    let cleartext_stream = tls.connect(conn_options, function () {
      log.log("Connection established to %s:%s", data.ip, data.port);
      protocol.init_conn(cleartext_stream, true);
      protocol.install_handler(ReplicationServerHandler, self.server);
      protocol.handler.fetch(workspace_id, function (err, result) {
        cb(err, result);
        try {
          protocol.handler.disconnect();
        } catch (e) {
          log.error(e);
        }
      });
    });
    cleartext_stream.setEncoding("utf8");
    cleartext_stream.on("error", function (err) {
      log.error("Error on replication connection!", err);
      // TODO: reconnect or send error back
    });
  } catch (e) {
    log.warn(e);
    // TODO: reconnect or send error back
    cb(e);
    return;
  }
};

MasterHandler.prototype.on_workspace = function (req_id, data) {
  var self = this,
    cb,
    action = data.action,
    workspace_id = data.id;

  if (!workspace_id || !_.isFinite(workspace_id)) {
    self.error(req_id, "No workspace ID or bad ID");
    return;
  }

  if (!action) {
    self.error(req_id, util.format("No action for workspace %s.", workspace_id));
    return;
  }

  data = data.data;

  cb = function (err, result) {
    if (err) {
      self.error(req_id, err.toString(), false);
    } else {
      let workspace = self.server.workspaces[workspace_id];
      self.write("workspace", req_id, {
        action: action,
        data: result || (workspace && workspace.to_master_json()),
      });
    }
  };

  switch (action) {
  case "create":
    slave.create_workspace(self.server, workspace_id, data.version, cb);
    break;
  case "delete":
    slave.delete_workspace(self.server, workspace_id, data.username, cb);
    break;
  case "evict":
    slave.evict_workspace(self.server, workspace_id, data.reason, cb);
    break;
  case "fetch":
    self.fetch_workspace(workspace_id, data, cb);
    break;
  case "get":
    slave.get_workspace(self.server, workspace_id, data, cb);
    break;
  case "update":
    slave.update_workspace(self.server, workspace_id, data, cb);
    break;
  case "verify":
    slave.verify_workspace(self.server, workspace_id, data, cb);
    break;
  default:
    self.error(req_id, util.format("Unknown action for workspace %s.", workspace_id));
  }
};

MasterHandler.prototype.broadcast = function (data, cb) {
  this.request("broadcast", data, cb);
};

MasterHandler.prototype.on_broadcast = function (req_id, req) {
  var self = this;

  let workspace;
  let pro_workspace;
  let from;
  let virtual_agent;

  switch (req.action) {
  case "to_user":
    // TODO: so inefficient
    _.each(this.server.workspaces, function (w) {
      _.each(w.handlers, function (h) {
        if (h.username === req.to) {
          h.request(req.data.name, req.data);
        }
      });
    });
    this.ack(req_id);
    break;
  case "to_path":
    // TODO: inefficient
    workspace = _.find(this.server.workspaces, function (w) {
      return util.format("%s/%s", w.owner, w.name) === req.to;
    });
    if (!workspace) {
      log.log("No local active workspace %s found", req.to);
      this.ack(req_id);
      return;
    }
    log.log("Found local workspace %s", workspace.toString());
    from = new VirtualAgent(this, {
      username: req.from,
    });
    workspace.broadcast(req.data.name, from, null, req.data);
    this.ack(req_id);
    break;
  case "solicit":
    // TODO: do this by capability, not lame attr probing
    pro_workspace = _.find(this.server.workspaces, function (w) {
      // so far, only pro workspace has this func
      return !!w.on_solicit;
    });
    if (!pro_workspace) {
      this.ack(req_id);
      return;
    }
    from = req.from.split("/");
    virtual_agent = new VirtualAgent(this.server.slave.handler, {
      username: req.data.username,
      room: {
        owner: from[0],
        name: from[1],
      }
    });
    pro_workspace.on_solicit(virtual_agent, req.data, function (err) {
      if (err) {
        // TODO
        self.error(req_id, err);
      }
      self.ack(req_id);
    });
    break;
  default:
    log.error("unsupported broadcast action", req.action, req);
    this.error(req_id, "unsupported broadcast", false);
    return;
  }
};

MasterHandler.prototype.on_error = function (req_id, data) {
  this.ack(req_id);
  log.error("From master:", data.msg);
};

MasterHandler.prototype.on_disconnect = function (req_id, data) {
  log.error("disconnected from master because %s.", data.reason);
  this.ack(req_id);
  this.destroy();
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
