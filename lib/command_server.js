var https = require("https");
var util = require("util");

var express = require("express");

var settings = require("./settings");



var delete_workspace = function (server, req, res) {
  var reason = "This workspace was deleted.",
    workspace = server.workspaces[req.params.workspace_id];

  if (!workspace || !workspace.evict) {
    return res.send(404);
  }

  if (req.body) {
    reason = util.format("%s deleted this workspace.", req.body.username);
  }

  workspace.evict(reason);
  return res.send(204);
};

var listen = function (port, server) {
  var app = express();

  app.use(express.basicAuth(settings.command_auth.username, settings.command_auth.password));
  app.use(express.bodyParser());

  app["delete"]("/workspace/:workspace_id", delete_workspace.bind(app, server));

  https.createServer({
    ca: server.ca,
    cert: server.cert,
    key: server.key
  }, app).listen(port);
};

exports.listen = listen;
