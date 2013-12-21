var fs = require("fs");
var os = require("os");
var path = require("path");
var util = require("util");

var async = require("async");
var levelup = require("levelup");
var log = require("floorine");
var _ = require("lodash");

var settings = require("./settings");


var get_db_path = function (workspace_id) {
  var db_path = path.normalize(path.join(settings.bufs_dir, workspace_id.toString(), "db"));

  if (db_path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Workspace id: %s. Bufs dir: %s", db_path, workspace_id, settings.bufs_dir);
    return;
  }
  return db_path;
};

var get_workspace_version = function (workspace_id, db, cb) {
  var close_db = false,
    db_path = get_db_path(workspace_id);

  if (!db_path) {
    return cb(util.format("Invalid path for workspace %s", workspace_id));
  }

  if (!db) {
    close_db = true;
    db = levelup(db_path, {
      cacheSize: 0,
      createIfMissing: false,
      valueEncoding: "json"
    });
  }
  db.get("version", function (err, result) {
    if (close_db) {
      db.close();
    }
    return cb(err, result);
  });
};

var read = function (workspace_id, db, start, end) {
  var close_db = false,
    db_path = get_db_path(workspace_id),
    rs;

  if (!db) {
    close_db = true;
    db = levelup(db_path, {
      createIfMissing: false,
      valueEncoding: "json"
    });
  }
  rs = db.createReadStream({
    start: start,
    end: end
  });
  if (close_db) {
    rs.on("close", function () {
      db.close();
    });
    rs.on("error", function (err) {
      log.error("Error reading %s %s-%s: %s", workspace_id, start, end, err);
      db.close();
    });
  }
  return rs;
};

var read_buf_content = function (workspace_id, db) {
  return read(workspace_id, db, "buf_content_", "buf_content_999999999999");
};

var read_buf_info = function (workspace_id, db) {
  return read(workspace_id, db, "buf_", "buf_999999999999");
};

module.exports = {
  get_workspace_version: get_workspace_version,
  read: read,
  read_buf_content: read_buf_content,
  read_buf_info: read_buf_info
};
