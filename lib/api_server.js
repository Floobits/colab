/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var child_process = require("child_process");
var http = require("http");
var https = require("https");
var os = require("os");
var path = require("path");
var util = require("util");

var _ = require("lodash");
var async = require("async");
var express = require("express");
var fs = require("fs-extra");
var log = require("floorine");

var ldb = require("./ldb");
var buffer = require("./buffer");
var RoomEvent = require("./room_event");
var settings = require("./settings");
var utils = require("./utils");
var slave = require("./slave/slave");


var on_metrics = function (server, req, res) {
  var metrics = {},
    status = "ok",
    message = "harro",
    type,
    reply;

  reply = function () {
    res.writeHead(200);
    var data = util.format("status %s %s\n", status, message);
    _.each(metrics, function (v, k) {
      data += util.format("metric %s int %s\n", k, v);
    });
    res.end(data);
  };

  if (req.params && req.params.metric) {
    type = req.params.metric;
  } else {
    type = req.url.split("/")[1];
  }

  if (type === undefined || (_.indexOf(["version", "platform", "client"], type) < 0)) {
    // This should never happen
    log.warn("Tried to fetch: " + type);
    status = "error";
    message = "404";
    return reply();
  }

  _.each(server.handlers, function (agent) {
    var metric = (agent[type] && agent[type].toString()) || "undefined";
    metric = metric.replace(/\s/g, "");

    if (!metrics[metric]) {
      metrics[metric] = 1;
    } else {
      metrics[metric] += 1;
    }
  });

  return reply();
};

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

  return res.json(response);
};

var on_workspaces_all = function (server, req, res) {
  var auto = {};
  log.debug("%s asked for all workspaces", req.ip);

  auto.load = slave.get_load;

  auto.workspaces = slave.all_workspaces.bind(null, server);

  async.auto(auto, function (err, result) {
    var response = {};
    if (err) {
      return res.send(500, err);
    }
    response.server_id = server.id;
    response.load = result.load;
    response.workspaces = result.workspaces;
    return res.json(response);
  });
};

var on_workspace_get = function (server, req, res) {
  var workspace_id = parseInt(req.params.workspace_id, 10);

  slave.get_workspace(server, workspace_id, {}, function (err, result) {
    if (err) {
      if (err.type === "NotFoundError") {
        return res.send(404);
      }
      if (err.type === "OpenError") {
        // TODO: delete from server db?
        log.error("%s exists in server DB but not filesystem", workspace_id);
      }
      return res.send(500, err.toString());
    }
    return res.json(result);
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
      return res.send(404);
    }
    res.type(buf.get_content_type());
    return res.send(buf._state);
  }

  auto = {};
  auto.db = function (cb) {
    ldb.get_db(null, workspace_id, null, cb);
  };

  auto.buf = ["db", function (cb, res) {
    ldb.get(res.db, workspace_id, util.format("buf_%s", buf_id), "json", cb);
  }];

  auto.buf_load = ["buf", function (cb, res) {
    var b, fake_room;
    if (res.buf.deleted) {
      // So we'll send back a 404
      return cb({
        type: "NotFoundError",
      });
    }
    // Hack so that buffer gets loaded the normal way
    fake_room = {
      db: res.db,
    };
    try {
      b = buffer.from_db(fake_room, res.buf);
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
        return res.send(404);
      }
      if (err.type === "OpenError" && err.message && err.message.indexOf("No such file or directory") !== -1) {
        return res.send(404);
      }
      // TODO: detect empty buf error and send
      // Empty buffer
      // return res.send(new Buffer(0));
      return res.send(500, err.toString());
    }
    res.type(result.buf_load.get_content_type());
    return res.send(result.buf_load._state);
  });
};

var verify_workspace = function (server, req, res) {
  var auto = {},
    errs = [],
    workspace_id = parseInt(req.params.workspace_id, 10);

  auto.server_db = function (cb) {
    server.db.get(util.format("version_%s", workspace_id), cb);
  };

  auto.db = ["server_db", function (cb) {
    ldb.get_db(null, workspace_id, null, cb);
  }];

  auto.verify_bufs = ["db", function (cb, res) {
    var db = res.db,
      brs;

    brs = db.createReadStream({
      start: "buf_",
      end: "buf_999999999999",
      valueEncoding: "json"
    });

    brs.on("data", function (data) {
      var buf_id = parseInt(data.key.slice(4), 10),
        expected_md5 = data.value.md5;
      db.get(util.format("buf_content_%s", buf_id), { valueEncoding: "binary" }, function (err, result) {
        if (err) {
          if (err.type === "NotFoundError") {
            err = null;
            result = new Buffer(0);
          }
        }
        var md5 = utils.md5(result);
        if (expected_md5 !== md5) {
          if (md5 === "d41d8cd98f00b204e9800998ecf8427e") {
            err = util.format("Buf %s/%s is empty!", workspace_id, buf_id);
          } else {
            err = util.format("Buf %s/%s md5 mismatch! Expected %s. Got %s", workspace_id, buf_id, expected_md5, md5);
            if (utils.md5(result.toString()) === expected_md5) {
              err += util.format("Encoding issue!");
            }
          }
        }
        if (err) {
          errs.push(err);
        }
      });
    });
    brs.on("close", cb);
  }];

  async.auto(auto, function (err, result) {
    if (result.db) {
      ldb.finish_db(result.db, workspace_id);
    }
    if (err) {
      if (err.type === "NotFoundError") {
        return res.send(404);
      }
      errs.push(err);
    }
    if (errs.length > 0) {
      return res.send(500, errs);
    }
    return res.send(204);
  });
};

// Fetch a workspace from another server
var fetch_workspace = function (server, req, res) {
  var ip = req.body.ip,
    port = req.body.port,
    proto = req.body.proto || "https",
    workspace_id = req.params.workspace_id;

  // TODO: validate req.body

  slave.fetch_workspace(server, workspace_id, proto, ip, port, function (err, result) {
    if (err) {
      return res.send(500, err.toString());
    }
    return res.json(200, result);
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
        return res.send(404, err);
      }
      log.error("Error deleting workspace %s: %s", workspace_id, err);
      return res.send(500, err.toString());
    }
    if (!result.exists) {
      return res.send(404);
    }
    return res.send(204);
  });
};

var set_workspace_version_by_id = function (server, req, res) {
  var workspace_id = parseInt(req.params.workspace_id, 10);

  slave.update_workspace(server, workspace_id, {
    version: req.body.version,
  }, function (err) {
    if (err) {
      return res.send(500, err);
    }
    return res.send(204);
  });
};

// Fetch a workspace from another server
var fetch_workspace = function (server, req, res) {
  var ip = req.body.ip,
    port = req.body.port,
    proto = req.body.proto || "https",
    workspace_id = req.params.workspace_id;

  // TODO: validate req.body

  slave.fetch_workspace(server, workspace_id, proto, ip, port, function (err, result) {
    if (err) {
      return res.send(500, err.toString());
    }
    return res.json(200, result);
  });
};


var listen = function (port, server) {
  var app = express(),
    auth = express.basicAuth(settings.auth.username, settings.auth.password),
    s;

  app.use(express.bodyParser());
  app.use(express.logger());

  // New URLs
  app.get("/workspaces/active", on_workspaces_active.bind(app, server));
  app.get("/workspaces/all", on_workspaces_all.bind(app, server));
  app.get("/workspace/:workspace_id/:buf_id", on_buf_get.bind(app, server));
  app.get("/workspace/:workspace_id", on_workspace_get.bind(app, server));
  app.get("/metric/:metric", on_metrics.bind(app, server));

  // Commands. Require auth.
  app.post("/workspace/:workspace_id/verify", auth, verify_workspace.bind(app, server));
  app.post("/workspace/:workspace_id/version", auth, set_workspace_version_by_id.bind(app, server));
  app["delete"]("/workspace/:workspace_id", auth, delete_workspace_by_id.bind(app, server));
  app.post("/fetch/:workspace_id", auth, fetch_workspace.bind(app, server));

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
