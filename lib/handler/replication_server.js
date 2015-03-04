/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var BaseAgentHandler = require("./base");
var ldb = require("../ldb");
var utils = require("../utils");
var RoomEvent = require("../room_event");
var slave = require("../slave/slave");
var settings = require("../settings");


var ReplicationServerHandler = function (protocol, auth_timeout_id, server) {
  BaseAgentHandler.apply(this, arguments);

  // Yeah we are super hip and always on the latest version
  this.proto_version = this.SUPPORTED_VERSIONS[this.SUPPORTED_VERSIONS.length - 1];
  this.server = server;
  this.db = server.db;
  this.perms = [
    "disconnect",
    "error",
    "get_buf",
    "msg",
    "ping",
    "pong",
    "room_info",
  ];
};

util.inherits(ReplicationServerHandler, BaseAgentHandler);

ReplicationServerHandler.prototype.name = "replicate";

ReplicationServerHandler.prototype.fetch = function (workspace_id, cb) {
  var self = this;

  self.workspace_id = workspace_id;
  self.cb = cb;
  utils.set_state(this, this.CONN_STATES.JOINED);
  clearTimeout(this.auth_timeout_id);

  self.request("replicate", {
    action: "auth",
    api_key: settings.auth.username,
    secret: settings.auth.password,
    colab_id: self.server.id,
    version: self.proto_version,
    backup: !!settings.backup,
    exclude: !!settings.exclude,
    colab_port: settings.json_port_ssl,
    api_port: settings.api_port,
    workspace_id: workspace_id,
  });
};

// TODO: just pass in the db, not the server
ReplicationServerHandler.prototype.on_room_info = function (res_id, ri) {
  var self = this,
    auto = {},
    workspace_id = self.workspace_id;

  self.room_info = ri;

  auto.mkdirp = function (cb) {
    slave.mkdirp(workspace_id, cb);
  };

  // TODO: remove deleted events instead of nuking them all and re-fetching
  auto.del_local_events = ["mkdirp", function (cb) {
    ldb.read_events(null, workspace_id, function (err, rs) {
      var actions = [];
      if (err) {
        if (err.type === "OpenError" && err.message && err.message.indexOf("does not exist") > 0) {
          // Squelch "DB doesn't exist" error
          err = null;
        } else {
          log.warn("Error reading local db %s: %s", workspace_id, err);
        }
      }
      if (!rs) {
        log.warn("no readstream for %s, %s", workspace_id, err);
        return cb(err);
      }
      rs.on("data", function (data) {
        actions.push({
          type: "del",
          key: data.key
        });
      });
      rs.on("end", function () {
        ldb.get_db(null, workspace_id, null, function (get_db_err, db) {
          if (get_db_err) {
            return cb(get_db_err);
          }
          db.batch(actions, function (batch_err) {
            ldb.close_db(db, workspace_id, function (close_err) {
              return cb(batch_err || close_err);
            });
          });
        });
      });
    });
  }];

  auto.local_readstream = ["del_local_events", function (cb) {
    ldb.read_buf_info(null, workspace_id, function (err, rs) {
      if (err) {
        if (err.type === "OpenError" && err.message.indexOf("does not exist") > 0) {
          // Squelch "DB doesn't exist" error
          err = null;
        } else {
          log.warn("Error reading local db %s: %s", workspace_id, err);
        }
      }
      return cb(err, rs);
    });
  }];

  auto.local_bufs = ["local_readstream", "del_local_events", function (cb, response) {
    var bufs = {},
      rs = response.local_readstream;

    cb = _.once(cb);

    if (!rs) {
      return cb(null, bufs);
    }
    rs.on("data", function (data) {
      var value = data.value;
      try {
        value = JSON.parse(value);
      } catch (e) {
        log.error("Error parsing %s: %s", data, e);
        return;
      }
      // TODO: optimization: move compare_bufs here
      bufs[value.id] = value;
    });
    rs.on("end", function () {
      cb(null, bufs);
    });
  }];

  auto.create_write_stream = ["local_bufs", function (cb) {
    ldb.write(null, workspace_id, "binary", cb);
  }];

  auto.write_stream_handlers = ["create_write_stream", function (cb, response) {
    cb = _.once(cb);
    response.create_write_stream.once("error", cb);
    response.create_write_stream.once("close", cb);
  }];

  auto.compare_bufs = ["local_bufs", "create_write_stream", function (cb, response) {
    var local_bufs = response.local_bufs,
      remote_bufs = self.room_info.bufs,
      to_delete = _.difference(_.keys(local_bufs), _.keys(remote_bufs)),
      to_fetch = [],
      ws = response.create_write_stream;

    cb = _.once(cb);

    _.each(to_delete, function (buf_id) {
      log.debug("Deleting %s/%s", workspace_id, buf_id);
      ws.write({
        key: util.format("buf_%s", buf_id),
        type: "del"
      });
    });

    _.each(remote_bufs, function (rbuf, rbuf_id) {
      var local_buf = local_bufs[rbuf_id];
      rbuf.deleted = !!rbuf.deleted;
      if (!local_buf || local_buf.md5 !== rbuf.md5) {
        to_fetch.push(rbuf);
        return;
      }
      if (_.isEqual(local_buf, rbuf)) {
        log.debug("Local copy of %s/%s matches remote. Not fetching.", workspace_id, rbuf.id);
        return;
      }
      log.log("Local copy of %s/%s differs from remote. Fetching.", workspace_id, rbuf.id);
      log.debug("local: %s remote %s", _.keys(local_buf), _.keys(rbuf));

      to_fetch.push(rbuf);
      ws.write({
        key: util.format("buf_%s", rbuf.id),
        value: {
          id: rbuf.id,
          path: rbuf.path,
          deleted: rbuf.deleted,
          md5: rbuf.md5,
          encoding: rbuf.encoding
        },
        valueEncoding: "json",
      });
    });

    return cb(null, to_fetch);
  }];

  auto.get_bufs = ["compare_bufs", function (get_bufs_cb, response) {
    var ws = response.create_write_stream;

    _.each(self.room_info.events, function (row) {
      var evt = new RoomEvent(row);
      log.debug("Writing room event: %s", JSON.stringify(evt.to_json()));
      ws.write({
        key: util.format("event_%s", evt.id),
        value: evt.to_json(),
        valueEncoding: "json",
      });
    });

    async.eachLimit(response.compare_bufs, 20, function (buf, cb) {
      self.request("get_buf", {
        id: buf.id,
      }, function (err, data) {
        if (err) {
          return cb(err, data);
        }
        ws.write({
          key: util.format("buf_%s", buf.id),
          value: {
            id: data.id,
            path: data.path,
            deleted: !!data.deleted,
            md5: data.md5,
            encoding: data.encoding
          },
          valueEncoding: "json",
        });
        if (data.buf.length > 0) {
          ws.write({
            key: util.format("buf_content_%s", buf.id),
            value: new Buffer(data.buf, data.encoding),
            valueEncoding: "binary",
          });
        }
        log.debug("Saved %s/%s.", workspace_id, buf.id);
        return cb(null, data);
      });
    }, get_bufs_cb);
  }];

  auto.close_ws = ["get_bufs", function (cb, response) {
    response.create_write_stream.end();
    return cb();
  }];

  async.auto(auto, function (err) {
    var version = self.room_info.version;
    if (err) {
      log.error("Error fetching workspace %s: %s", workspace_id, err.toString());
      return self.cb(err.toString());
    }
    if (!_.isFinite(version)) {
      log.error("Workspace %s had bad version: %s", workspace_id, version);
      return self.cb(util.format("Workspace %s had bad version: %s", workspace_id, version));
    }
    self.server.db.put(util.format("version_%s", workspace_id), version, function (version_err) {
      if (version_err) {
        log.error("Error updating workspace %s version: %s", workspace_id, version_err.toString());
        return self.cb(version_err);
      }
      log.debug("Fetched workspace %s", workspace_id);
      return self.cb(null, {
        version: version,
        active: false
      });
    });
  });
  //TODO: teardown and disconnect
};

ReplicationServerHandler.prototype.on_msg = function () {
  // TODO: save events
  return;
};

module.exports = ReplicationServerHandler;
