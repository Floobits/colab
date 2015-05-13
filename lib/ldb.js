"use strict";

const path = require("path");

const levelup = require("levelup");
const log = require("floorine");
const _ = require("lodash");

const settings = require("./settings");

var open_dbs = {};

var get_db_path = function (workspace_id) {
  var db_path = path.normalize(path.join(settings.bufs_dir, workspace_id.toString(), "db"));

  if (db_path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Workspace id: %s. Bufs dir: %s", db_path, workspace_id, settings.bufs_dir);
    return null;
  }
  return db_path;
};

var get_db = function (db, workspace_id, options, cb) {
  var db_path = get_db_path(workspace_id);

  db = db || open_dbs[workspace_id];

  options = _.defaults(options || {}, {
    createIfMissing: false
  });

  if (db) {
    log.debug("DB %s status: %s", workspace_id, db._status);
    if (db._status === "closing") {
      db.on("closed", function () {
        setImmediate(get_db.bind(null, null, workspace_id, options, cb));
      });
      return null;
    }
    if (db._status === "closed") {
      log.debug("DB %s status closed. deleting and re-getting...", workspace_id);
      delete open_dbs[workspace_id];
      setImmediate(get_db.bind(null, null, workspace_id, options, cb));
      return null;
    }
    db.refcount++;
    delete db.finished_at;
    return cb(null, db);
  }

  db = levelup(db_path, options, function (err, level_db) {
    if (err) {
      delete open_dbs[workspace_id];
      return cb(err);
    }
    return cb(null, level_db);
  });
  db.refcount = 1;
  open_dbs[workspace_id] = db;
};

var close_db = function (db, workspace_id, cb) {
  db.close(function (err) {
    if (err) {
      log.error("Error closing %s: %s", workspace_id, err);
    }
    if (open_dbs[workspace_id] && open_dbs[workspace_id]._status === "closed") {
      delete open_dbs[workspace_id];
    }
    if (cb) {
      cb(err);
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
  db.finished_at = db.finished_at || Date.now();
  open_dbs_len = _.size(open_dbs);
  if (open_dbs_len <= settings.max_open_dbs) {
    return;
  }
  _.each(open_dbs, function (open_db, open_workspace_id) {
    if (open_db.refcount > 0 || !_.isFinite(open_db.finished_at)) {
      return;
    }
    if (open_db._status === "closing" || open_db._status === "closed") {
      return;
    }
    dbs_to_close.push({db: open_db, workspace_id: open_workspace_id});
  });
  dbs_to_close
    .sort(function (a, b) { return b.db.finished_at - a.db.finished_at; })
    .slice(settings.max_open_dbs)
    .forEach(function (db_to_close) {
      close_db(db_to_close.db, db_to_close.workspace_id);
    });
};

var get = function (maybe_db, workspace_id, key, encoding, cb) {
  if (_.isFunction(encoding)) {
    cb = encoding;
    encoding = null;
  }
  encoding = encoding || "json";

  get_db(maybe_db, workspace_id, null, function (err, db) {
    if (err) {
      return cb(err);
    }
    db.get(key, { valueEncoding: encoding }, function (ldb_err, result) {
      finish_db(db, workspace_id);
      return cb(ldb_err, result);
    });
  });
};

var read = function (maybe_db, workspace_id, start, end, encoding, cb) {
  var fin_db = _.once(finish_db);
  get_db(maybe_db, workspace_id, null, function (err, db) {
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
      fin_db(db, workspace_id);
    });
    rs.on("error", function (rs_err) {
      log.error("Error reading %s %s - %s: %s", workspace_id, start, end, rs_err);
    });
    return cb(err, rs);
  });
};

var del = function (maybe_db, workspace_id, key, cb) {
  get_db(maybe_db, workspace_id, null, function (err, db) {
    if (err) {
      return cb(err);
    }
    db.del(key, cb);
  });
};

var read_buf_content = function (db, workspace_id, cb) {
  return read(db, workspace_id, "buf_content_", "buf_content_999999999999", "binary", cb);
};

var read_buf_info = function (db, workspace_id, cb) {
  return read(db, workspace_id, "buf_", "buf_999999999999", "utf8", cb);
};

var read_events = function (db, workspace_id, cb) {
  return read(db, workspace_id, "event_", "event_999999999999", "utf8", cb);
};


if (!_.isFinite(settings.max_open_dbs)) {
  settings.max_open_dbs = 10;
}
if (settings.log_level === "debug") {
  setInterval(function () {
    log.debug("%s open dbs", _.size(open_dbs));
    _.each(open_dbs, function (db, id) {
      log.debug("  workspace %s refcount %s", id, db.refcount);
    });
  }, 60000);
}

module.exports = {
  close_db: close_db,
  del: del,
  finish_db: finish_db,
  get_db_path: get_db_path,
  get_db: get_db,
  get: get,
  open_dbs: open_dbs,
  read: read,
  read_buf_content: read_buf_content,
  read_buf_info: read_buf_info,
  read_events: read_events,
};
