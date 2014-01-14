var fs = require("fs");
var os = require("os");
var path = require("path");
var util = require("util");

var async = require("async");
var levelup = require("levelup");
var log = require("floorine");
var _ = require("lodash");

var settings = require("./settings");
if (!_.isFinite(settings.max_open_dbs)) {
  settings.max_open_dbs = 100;
}

var open_dbs = {};

setInterval(function () {
  log.log("%s open dbs", _.size(open_dbs));
  _.each(open_dbs, function (db, id) {
    log.log("  workspace %s refcount %s", id, db.refcount);
  });
}, 15000);


var get_db_path = function (workspace_id) {
  var db_path = path.normalize(path.join(settings.bufs_dir, workspace_id.toString(), "db"));

  if (db_path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Workspace id: %s. Bufs dir: %s", db_path, workspace_id, settings.bufs_dir);
    return;
  }
  return db_path;
};

var get_db = function (db, workspace_id, options, cb) {
  var db_path = get_db_path(workspace_id);

  db = db || open_dbs[workspace_id];

  options = _.defaults(options || {}, {
    cacheSize: 0,
    createIfMissing: false
  });

  // XXXX work-around to prevent memory leak
  options.cacheSize = 0;

  if (db) {
    log.debug("DB %s status: %s", workspace_id, db._status);
    if (db._status === "closing") {
      log.debug("DB %s closing...", workspace_id);
      db.on("closed", function () {
        setImmediate(get_db.bind(null, null, workspace_id, null, cb));
      });
      return;
    }
    if (db._status === "closed") {
      log.debug("DB %s status closed. deleting and re-getting...", workspace_id);
      delete open_dbs[workspace_id];
      setImmediate(get_db.bind(null, null, workspace_id, null, cb));
      return;
    }
    db.refcount++;
    delete db.finished_at;
    return cb(null, db);
  }

  log.debug("DB %s opening...", workspace_id);
  db = levelup(db_path, options, function (err, db) {
    if (err) {
      delete open_dbs[workspace_id];
      return cb(err);
    }
    log.debug("DB %s opened.", workspace_id);
    return cb(null, db);
  });
  db.refcount = 1;
  open_dbs[workspace_id] = db;
};

var close_db = function (db, workspace_id) {
  log.debug("DB %s closing...", workspace_id);
  db.close(function (err) {
    log.debug("DB %s closed.", workspace_id);
    if (err) {
      log.error("Error closing %s: %s", workspace_id, err);
    }
    if (open_dbs[workspace_id] && open_dbs[workspace_id]._status === "closed") {
      delete open_dbs[workspace_id];
    }
  });
};

var finish_db = function (db, workspace_id) {
  var dbs_to_close = [],
    open_dbs_len;
  db.refcount--;
  if (db.refcount > 0) {
    return;
  }
  if (db.refcount < 0) {
    log.error("Refcount for %s is negative! This should never happen!", workspace_id);
  }
  db.finished_at = Date.now();
  open_dbs_len = _.size(open_dbs);
  if (open_dbs_len <= settings.max_open_dbs) {
    return;
  }
  _.each(open_dbs, function (db, workspace_id) {
    if (db.refcount > 0 || !_.isFinite(db.finished_at)) {
      return;
    }
    dbs_to_close.push({db: db, workspace_id: workspace_id});
  });
  dbs_to_close.sort(function (a, b) {
    return a.db.finished_at - b.db.finished_at;
  });
  dbs_to_close = dbs_to_close.slice(0, settings.max_open_dbs);
  _.each(dbs_to_close, function (db) {
    close_db(db.db, db.workspace_id);
  });
};

var get = function (db, workspace_id, key, encoding, cb) {
  if (_.isFunction(encoding)) {
    cb = encoding;
    encoding = null;
  }
  encoding = encoding || "json";

  get_db(db, workspace_id, null, function (err, db) {
    if (err) {
      return cb(err);
    }
    db.get(key, { valueEncoding: encoding }, function (err, result) {
      finish_db(db, workspace_id);
      return cb(err, result);
    });
  });
};

var read = function (db, workspace_id, start, end, encoding, cb) {
  get_db(db, workspace_id, null, function (err, db) {
    var rs;
    if (err) {
      return cb(err);
    }
    rs = db.createReadStream({
      start: start,
      end: end,
      valueEncoding: encoding
    });
    rs.on("close", function () {
      finish_db(db, workspace_id);
    });
    rs.on("error", function (err) {
      log.error("Error reading %s %s-%s: %s", workspace_id, start, end, err);
      close_db(db, workspace_id);
    });
    return cb(err, rs);
  });
};

var write = function (db, workspace_id, encoding, cb) {
  get_db(db, workspace_id, { createIfMissing: true }, function (err, db) {
    var ws;
    if (err) {
      return cb(err);
    }
    ws = db.createWriteStream({
      valueEncoding: encoding
    });
    ws.on("close", function () {
      finish_db(db, workspace_id);
    });
    ws.on("error", function (err) {
      log.error("Error writing %s: %s", workspace_id, err);
      close_db(db, workspace_id);
    });
    return cb(err, ws);
  });
};

var read_buf_content = function (db, workspace_id, cb) {
  return read(db, workspace_id, "buf_content_", "buf_content_999999999999", "binary", cb);
};

var read_buf_info = function (db, workspace_id, cb) {
  return read(db, workspace_id, "buf_", "buf_999999999999", "json", cb);
};


module.exports = {
  finish_db: finish_db,
  get_db_path: get_db_path,
  get_db: get_db,
  get: get,
  read: read,
  read_buf_content: read_buf_content,
  read_buf_info: read_buf_info,
  write: write
};
