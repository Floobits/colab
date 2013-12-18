var fs = require("fs");
var http = require("http");
var https = require("https");
var util = require("util");

var express = require("express");
var log = require("floorine");
var _ = require("lodash");

var settings = require("./settings");


var load_workspace = function (server, name, owner, id, load) {
  var workspace = _.where(server.workspaces, {
    name: name,
    owner: owner
  });

  if (workspace.length === 0 || !workspace[0].evict) {
    if (!load) {
      return;
    }
    // TODO: load workspace from disk
    log.error("Couldn't load %s (%s/%s) Implement me!", id, name, owner);
    return;
  }
  return workspace[0];
};

var delete_workspace = function (server, req, res) {
  var reason = "This workspace was deleted.",
    workspace = load_workspace(server, req.params.workspace, req.params.owner);

  if (!workspace) {
    return res.send(404);
  }

  if (req.body && req.body.username) {
    reason = util.format("%s deleted this workspace.", req.body.username);
  }
  workspace.evict(reason);

  fs.rmdir(workspace.path, function (err) {
    if (err) {
      return res.send(500, err);
    }
    return res.send(204);
  });
};

var evict_workspace = function (server, req, res, reason) {
  var workspace = load_workspace(server, req.params.workspace, req.params.owner);

  if (!workspace) {
    return res.send(404);
  }
  workspace.evict(reason || req.body.reason);
  return res.send(204);
};

var set_workspace_version = function (server, req, res) {
  var workspace = load_workspace(server, req.params.workspace, req.params.owner);

  if (!workspace) {
    return res.send(404);
  }

  workspace.version = req.body.version;
  workspace.save(function (err) {
    if (err) {
      return res.send(500, err);
    }
    return res.send(204);
  });
};

var motd = function (server, req, res) {
  log.log("MOTD:", req.body);
  server.motd = req.body.msg;
  return res.send(200, req.body.msg);
};

var wallops = function (server, req, res) {
  var msg = "Attention all Floobits users: " + req.body.msg;

  log.log("Wallops:", req.body);
  if (!req.body.msg) {
    log.error("No message. Bad request.");
    return res.send(400, "NEED A MESSAGE");
  }

  _.each(server.agents, function (agent) {
    agent.error(msg, true);
  });

  log.log("Sent wallops to everyone:", msg);
  return res.send(200, msg);
};

var listen = function (port, server) {
  var app = express(),
    s;

  app.use(express.basicAuth(settings.command_auth.username, settings.command_auth.password));
  app.use(express.bodyParser());
  app.use(express.logger());

  app["delete"]("/r/:owner/:workspace", delete_workspace.bind(app, server));
  app.post("/r/:owner/:workspace/evict", evict_workspace.bind(app, server));
  app.post("/r/:owner/:workspace/version", set_workspace_version.bind(app, server));
  app.post("/motd", motd.bind(app, server));
  app.post("/wallops", wallops.bind(app, server));

  if (server.cert && server.key) {
    s = https.createServer({
      ca: server.ca,
      cert: server.cert,
      key: server.key
    }, app);
  } else {
    s = http.createServer(app);
  }
  s.listen(port);
};

exports.listen = listen;
