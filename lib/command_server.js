var http = require("http");
var https = require("https");
var path = require("path");
var util = require("util");

var async = require("async");
var express = require("express");
var fs = require("fs-extra");
var log = require("floorine");
var request = require("request");
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
    if (!id) {
      // TODO: load workspace from disk based on name & owner?
      log.error("No id for %s (%s/%s) Implement me!", name, owner);
      return;
    }
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

  // TODO: do something about the callback
  server.db.del(util.format("version_%s", workspace.id));

  if (workspace.path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Bufs dir: %s", workspace.path, settings.bufs_dir);
    return res.send(500);
  }

  fs.remove(workspace.path, function (err) {
    if (err) {
      return res.send(500, err);
    }
    return res.send(204);
  });
};

var delete_workspace_by_id = function (server, req, res) {
  var reason = "This workspace was deleted.",
    workspace_id = req.params.workspace_id,
    workspace = server.workspaces[workspace_id],
    workspace_path = path.normalize(path.join(settings.bufs_dir, workspace_id));

  if (workspace) {
    if (req.body && req.body.username) {
      reason = util.format("%s deleted this workspace.", req.body.username);
    }
    workspace.evict(reason);
  }

  // TODO: check if workspace is active and evict and all that
  if (workspace_path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Bufs dir: %s", workspace_path, settings.bufs_dir);
    return res.send(500);
  }

  fs.exists(workspace_path, function (exists) {
    if (!exists) {
      return res.send(404);
    }
    // TODO: do something about the callback
    server.db.del(util.format("version_%s", workspace_id));

    fs.remove(workspace_path, function (err) {
      if (err) {
        return res.send(500, err);
      }
      return res.send(204);
    });
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

// Fetch a workspace from another server
var fetch_workspace = function (server, req, res) {
  var auto = {},
    ip = req.body.ip,
    port = req.body.port,
    proto = req.body.proto || "http",
    workspace_id = req.params.workspace_id;

  // TODO: validate req.body

  if (server.workspaces[workspace_id]) {
    // TODO: make it ok to fetch active workspaces?
    return res.send(400, util.format("Workspace %s is active!", workspace_id));
  }

  auto.get_buf_list = function (cb) {
    var url = util.format("%s://%s:%s/workspace/%s", proto, ip, port, workspace_id);
    request.get(url, function (err, response, body) {
      if (err) {
        return cb(err, response);
      }
      return cb(err, body);
    });
  };

  auto.get_bufs = ["get_buf_list", function (cb, response) {
    async.eachLimit(response.get_buf_list, 20, function (buf, cb) {
      var url = util.format("%s://%s:%s/workspace/%s/%s", proto, ip, port, workspace_id, buf.id);
      request.get(url, function (err, response, body) {
        if (err) {
          return cb(err, response);
        }
        return cb(null, body);
      });
    }, cb);
  }];

  async.auto(auto, function (err, result) {
    if (err) {
      return res.send(500, err.toString());
    }
    log.debug(result);
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

  app["delete"]("/workspace/:workspace_id", delete_workspace_by_id.bind(app, server));
  app.post("/fetch/:workspace_id", fetch_workspace.bind(app, server));
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
