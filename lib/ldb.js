var fs = require("fs");
var os = require("os");
var path = require("path");
var util = require("util");

var async = require("async");
var levelup = require("levelup");
var log = require("floorine");
var _ = require("lodash");

var settings = require("./settings");

var open_dbs = {};


var get_db_path = function (workspace_id) {
  var db_path = path.normalize(path.join(settings.bufs_dir, workspace_id.toString(), "db"));

  if (db_path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Workspace id: %s. Bufs dir: %s", db_path, workspace_id, settings.bufs_dir);
    return;
  }
  return db_path;
};

var get = function (db, workspace_id, key, encoding, cb) {
  var db_path = get_db_path(workspace_id);

  if (_.isFunction(encoding)) {
    cb = encoding;
    encoding = null;
  }
  encoding = encoding || "json";

  if (!db_path) {
    return cb(util.format("Invalid path for workspace %s", workspace_id));
  }

  db = db || open_dbs[workspace_id];

  if (db) {
    if (db._status === "closing") {
      db.on("close", function () {
        setImmediate(get.bind(null, null, workspace_id, key, encoding, cb));
      });
      return;
    }
    if (db._status === "closed") {
      delete open_dbs[workspace_id];
      setImmediate(get.bind(null, null, workspace_id, key, encoding, cb));
      return;
    }
    db.refcount++;
  } else {
    db = levelup(db_path, {
      cacheSize: 0,
      createIfMissing: false,
      valueEncoding: encoding
    });
    db.refcount = 1;
    open_dbs[workspace_id] = db;
  }
  db.get(key, function (err, result) {
    db.refcount--;
    if (db.refcount <= 0) {
      if (db.refcount < 0) {
        log.error("Refcount for %s is negative! This should never happen!", workspace_id);
      }
      db.close(function (err) {
        if (err) {
          log.error("Error closing %s: %s", workspace_id, err);
        }
        delete open_dbs[workspace_id];
      });
    }
    return cb(err, result);
  });
};

var read = function (db, workspace_id, start, end, encoding, cb) {
  var close_db = false,
    db_path = get_db_path(workspace_id);

  function finish(err, db) {
    var rs;
    if (err) {
      return cb(err, db);
    }
    rs = db.createReadStream({
      start: start,
      end: end,
      valueEncoding: encoding
    });
    if (close_db) {
      rs.on("close", function () {
        db.close(function (err) {
          log.debug("Closed db %s: %s", db_path, err);
        });
      });
      rs.on("error", function (err) {
        log.error("Error reading %s %s-%s: %s", workspace_id, start, end, err);
        db.close(function (err) {
          log.debug("Closed db after error %s: %s", db_path, err);
        });
      });
    }
    return cb(err, rs);
  }

  if (db) {
    return finish(null, db);
  }
  close_db = true;
  levelup(db_path, {
    createIfMissing: false,
    valueEncoding: encoding
  }, finish);
};

var read_buf_content = function (db, workspace_id, cb) {
  return read(db, workspace_id, "buf_content_", "buf_content_999999999999", "binary", cb);
};

var read_buf_info = function (db, workspace_id, cb) {
  return read(db, workspace_id, "buf_", "buf_999999999999", "json", cb);
};


module.exports = {
  get_db_path: get_db_path,
  get: get,
  read: read,
  read_buf_content: read_buf_content,
  read_buf_info: read_buf_info
};
