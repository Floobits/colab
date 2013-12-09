var http = require("http");
var https = require("https");
var util = require("util");

var express = require("express");
var log = require("floorine");
var _ = require("lodash");

var settings = require("./settings");


var delete_workspace = function (server, req, res) {
  var reason = "This workspace was deleted.",
    workspace = _.where(server.workspaces, {
      name: req.params.workspace,
      owner: req.params.owner
    });

  if (workspace.length === 0 || !workspace[0].evict) {
    return res.send(404);
  }

  workspace = workspace[0];

  if (req.body) {
    reason = util.format("%s deleted this workspace.", req.body.username);
  }

  workspace.evict(reason);
  return res.send(204);
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

  app["delete"]("/r/:owner/:workspace", delete_workspace.bind(app, server));
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
