"use strict";

var http = require("http");
var https = require("https");
var util = require("util");

var _ = require("lodash");
var async = require("async");
var bodyParser = require("body-parser");
var express = require("express");
var log = require("floorine");
var morgan = require("morgan");

var ldb = require("./ldb");
var buffer = require("./buffer");
var settings = require("./settings");
var utils = require("./utils");
var slave = require("./slave/slave");


var on_workspaces_active = function (server, req, res) {
  var response = {};

  log.debug("%s asked for active workspaces", req.ip);

  response.workspaces = _.map(server.workspaces, function (workspace) {
    return {
      id: workspace.id,
      name: workspace.name,
      owner: workspace.owner,
      users: _.map(workspace.handlers, function (agent) {
        return {
          client: agent.client,
          user_id: agent.user_id,
          is_anon: agent.is_anon,
          platform: agent.platform,
          username: agent.username,
          version: agent.version
        };
      }),
      version: workspace.version
    };
  });

  return res.status(200).json(response);
};

var on_workspaces_all = function (server, req, res) {
  var auto = {};
  log.debug("%s asked for all workspaces", req.ip);

  auto.load = slave.get_load;

  auto.workspaces = slave.all_workspaces.bind(null, server);

  async.auto(auto, function (err, result) {
    var response = {};
    if (err) {
      return res.status(500).send(err);
    }
    response.server_id = server.id;
    response.load = result.load;
    response.workspaces = result.workspaces;
    return res.status(200).json(response);
  });
};

var on_workspace_get = function (server, req, res) {
  var workspace_id = parseInt(req.params.workspace_id, 10);

  slave.get_workspace(server, workspace_id, {}, function (err, result) {
    if (err) {
      if (err.type === "NotFoundError") {
        return res.status(404).end();
      }
      if (err.type === "OpenError") {
        // TODO: delete from server db?
        log.error("%s exists in server DB but not filesystem", workspace_id);
      }
      return res.status(500).send(err.toString());
    }
    return res.status(200).json(result);
  });
};

var on_buf_get = function (server, req, res) {
  var auto,
    buf,
    buf_id = parseInt(req.params.buf_id, 10),
    workspace_id = parseInt(req.params.workspace_id, 10),
    workspace = server.workspaces[workspace_id];

  // TODO: check etag. send content Content-MD5 header
  if (workspace) {
    buf = workspace.bufs[buf_id];
    if (!buf || buf.deleted) {
      return res.status(404).end();
    }
    res.type(buf.get_content_type());
    return res.status(200).send(buf._state);
  }

  auto = {};
  auto.db = function (cb) {
    ldb.get_db(null, workspace_id, null, cb);
  };

  auto.buf = ["db", function (cb, result) {
    ldb.get(result.db, workspace_id, util.format("buf_%s", buf_id), "json", cb);
  }];

  auto.buf_load = ["buf", function (cb, result) {
    var b, fake_room;
    if (result.buf.deleted) {
      // So we'll send back a 404
      return cb({
        type: "NotFoundError",
      });
    }
    // Hack so that buffer gets loaded the normal way
    fake_room = {
      db: result.db,
    };
    try {
      b = buffer.from_db(fake_room, result.buf);
      b.load(cb);
    } catch (e) {
      cb(e);
    }
  }];

  async.auto(auto, function (err, result) {
    if (result.db) {
      ldb.finish_db(result.db, workspace_id);
    }
    if (err) {
      log.error("on_buf_get:", err);
      if (err.type === "NotFoundError") {
        return res.status(404).end();
      }
      if (err.type === "OpenError" && err.message && err.message.indexOf("No such file or directory") !== -1) {
        return res.status(404).end();
      }
      // TODO: detect empty buf error and send
      // Empty buffer
      // return res.send(new Buffer(0));
      return res.status(500).send(err.toString());
    }
    res.type(result.buf_load.get_content_type());
    return res.status(200).send(result.buf_load._state);
  });
};

var delete_workspace_by_id = function (server, req, res) {
  var workspace_id = parseInt(req.params.workspace_id, 10),
    username;

  if (req.body && req.body.username) {
    username = req.body.username;
  }

  slave.delete_workspace(server, workspace_id, username, function (err, result) {
    if (err) {
      if (err.type === "NotFoundError") {
        return res.status(404).send(err);
      }
      log.error("Error deleting workspace %s: %s", workspace_id, err);
      return res.status(500).send(err.toString());
    }
    if (!result.exists) {
      return res.status(404).end();
    }
    return res.status(204).end();
  });
};


var listen = function (port, server) {
  var app = express(),
    auth = utils.basic_auth(settings.auth.username, settings.auth.password),
    s;

  app.use(bodyParser.json());
  app.use(morgan("dev"));
  app.set("view cache", false);
  app.set("etag", false);

  // New URLs
  app.get("/workspaces/active", on_workspaces_active.bind(app, server));
  app.get("/workspaces/all", on_workspaces_all.bind(app, server));
  app.get("/workspace/:workspace_id/:buf_id", on_buf_get.bind(app, server));
  app.get("/workspace/:workspace_id", on_workspace_get.bind(app, server));

  // Commands. Require auth.
  app.delete("/workspace/:workspace_id", auth, delete_workspace_by_id.bind(app, server));

  if (server.cert && server.key) {
    s = https.createServer({
      ca: server.ca,
      cert: server.cert,
      key: server.key
    }, app);
  } else {
    log.warn("No cert info. Using insecure HTTP.");
    s = http.createServer(app);
  }
  s.listen(port);
};


module.exports = {
  listen: listen
};
