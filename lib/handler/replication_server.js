"use strict";

const util = require("util");

const _ = require("lodash");
const async = require("async");
const log = require("floorine");

const BaseAgentHandler = require("./base");
const ldb = require("../ldb");
const perms = require("../perms");
const RoomEvent = require("../room_event");
const settings = require("../settings");
const slave = require("../slave/slave");
const utils = require("../utils");


const ReplicationServerHandler = function (protocol, auth_timeout_id, server) {
  var self = this;
  BaseAgentHandler.apply(this, arguments);

  // Yeah we are super hip and always on the latest version
  this.proto_version = this.SUPPORTED_VERSIONS[this.SUPPORTED_VERSIONS.length - 1];
  this.server = server;
  this.db = server.db;
  this.workspace_id = null;
  this.cb = null;
  // Let colab send pretty much anything to us
  this.perms = perms.all_perms.concat([
    "disconnect",
    "error",
    "get_buf",
    "join",
    "part",
    "room_info",
  ]);
  _.each(this.perms, function (perm) {
    if (_.isUndefined(self["on_" + perm])) {
      self["on_" + perm] = function () {
        return;
      };
    }
  });
};

util.inherits(ReplicationServerHandler, BaseAgentHandler);

ReplicationServerHandler.prototype.name = "replicate";

ReplicationServerHandler.prototype.toString = function () {
  const self = this;
  return util.format("conn_id %s %s %s", self.id, self.name, self.workspace_id);
};

ReplicationServerHandler.prototype.fetch = function (workspace_id, cb) {
  var self = this;

  self.workspace_id = workspace_id;
  self.cb = _.once(cb);

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

ReplicationServerHandler.prototype.destroy = function () {
  this.cb("Connection destroyed before replication finished.");
  this.server = null;
  this.db = null;
  ReplicationServerHandler.super_.prototype.destroy.call(this);
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

  auto.db = ["mkdirp", function (cb) {
      ldb.get_db(null, workspace_id, {
        createIfMissing: true,
      }, cb);
    }];

  // TODO: remove deleted events instead of nuking them all and re-fetching
  auto.del_local_events = ["mkdirp", "db", function (cb, response) {
    ldb.read_events(response.db, workspace_id, function (err, rs) {
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
        response.db.batch(actions, cb);
      });
    });
  }];

  auto.local_readstream = ["del_local_events", function (cb, response) {
    ldb.read_buf_info(response.db, workspace_id, function (err, rs) {
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

  auto.delete_bufs = ["db", "local_bufs", function (cb, response) {
    const db = response.db;
    let to_delete = _.difference(_.keys(response.local_bufs), _.keys(self.room_info.bufs));

    async.each(to_delete, function (buf_id, del_cb) {
      log.debug("Deleting %s/%s", workspace_id, buf_id);
      db.del(util.format("buf_%s", buf_id), del_cb);
    }, cb);
  }];

  auto.compare_bufs = ["db", "local_bufs", function (cb, response) {
    const db = response.db;
    const local_bufs = response.local_bufs;
    const remote_bufs = _.values(self.room_info.bufs);
    let to_fetch = [];

    async.each(remote_bufs, function (rbuf, buf_cb) {
      let local_buf = local_bufs[rbuf.id];
      rbuf.deleted = !!rbuf.deleted;
      if (!local_buf || local_buf.md5 !== rbuf.md5) {
        log.debug("to_fetch: %s/%s", workspace_id, rbuf.id);
        to_fetch.push(rbuf);
        buf_cb();
        return;
      }
      if (_.isEqual(local_buf, rbuf)) {
        log.debug("Local copy of %s/%s matches remote. Not fetching.", workspace_id, rbuf.id);
        buf_cb();
        return;
      }
      log.log("Local copy of %s/%s differs from remote. Fetching.", workspace_id, rbuf.id);
      log.debug("local: %s remote %s", _.keys(local_buf), _.keys(rbuf));

      to_fetch.push(rbuf);
      db.put(util.format("buf_%s", rbuf.id), {
        id: rbuf.id,
        path: rbuf.path,
        deleted: rbuf.deleted,
        md5: rbuf.md5,
        encoding: rbuf.encoding
      }, {
        valueEncoding: "json",
      }, buf_cb);
    }, function (err) {
      return cb(err, to_fetch);
    });
  }];

  auto.save_events = ["compare_bufs", function (cb, response) {
    const db = response.db;
    async.each(self.room_info.events, function (row, evt_cb) {
      var evt = new RoomEvent(row);
      log.debug("Writing room event: %s", JSON.stringify(evt.to_json()));
      db.put(util.format("event_%s", evt.id), evt.to_json(), {
        valueEncoding: "json",
      }, evt_cb);
    }, cb);
  }];

  auto.get_bufs = ["compare_bufs", function (get_bufs_cb, response) {
    const db = response.db;
    function save_bufs (buf, cb) {
      log.debug("Fetching %s/%s", workspace_id, buf.id);
      self.request("get_buf", {
        id: buf.id,
      }, function (err, data) {
        if (err) {
          return cb(err, data);
        }
        db.put(util.format("buf_%s", buf.id), {
          id: data.id,
          path: data.path,
          deleted: !!data.deleted,
          md5: data.md5,
          encoding: data.encoding,
        }, {
          valueEncoding: "json",
        }, function (buf_err) {
          if (buf_err) {
            return cb(buf_err, data);
          }
          if (!data.buf || data.buf.length === 0) {
            return cb(null, data);
          }
          db.put(
            util.format("buf_content_%s", buf.id),
            new Buffer(data.buf, data.encoding), {
              valueEncoding: "binary",
            }, function (content_err) {
              log.debug("Saved %s/%s.", workspace_id, buf.id);
              return cb(content_err, data);
            });
        });
      });
    }
    log.log("Workspace %s: Fetching %s bufs", workspace_id, _.size(response.compare_bufs));
    async.eachLimit(response.compare_bufs, 20, save_bufs, get_bufs_cb);
  }];

  auto.finish_db = ["get_bufs", function (cb, response) {
    ldb.finish_db(response.db, workspace_id);
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
    if (!self.db) {
      return self.cb(util.format("Workspace %s lost db before replication finished", workspace_id));
    }
    self.db.put(util.format("version_%s", workspace_id), version, function (version_err) {
      if (version_err) {
        log.error("Error updating workspace %s version: %s", workspace_id, version_err.toString());
        return self.cb(version_err);
      }
      log.log("Fetched workspace %s version %s", workspace_id, version);
      return self.cb(null, {
        version: version,
        active: false,
        id: workspace_id,
      });
    });
  });
  //TODO: teardown and disconnect
};

ReplicationServerHandler.prototype.on_msg = function () {
  // TODO: save events
  return;
};

ReplicationServerHandler.prototype.on_get_buf = function () {
  // TODO: something
  return;
};

module.exports = ReplicationServerHandler;
