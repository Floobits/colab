"use strict";

const path = require("path");

const levelup = require("levelup");
const log = require("floorine");
const _ = require("lodash");

const settings = require("./settings");

const open_dbs = {};

function get_db_path(workspace_id) {
  const db_path = path.normalize(path.join(settings.bufs_dir, workspace_id.toString(), "db"));
  if (db_path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Workspace id: %s. Bufs dir: %s", db_path, workspace_id, settings.bufs_dir);
    return null;
  }
  return db_path;
}

function get_db(db, workspace_id, options, cb) {
  const db_path = get_db_path(workspace_id);

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

  log.debug("DB opening %s", workspace_id);
  db = levelup(db_path, options, function (err, level_db) {
    if (err) {
      delete open_dbs[workspace_id];
      return cb(err);
    }
    return cb(null, level_db);
  });
  db.refcount = 1;
  open_dbs[workspace_id] = db;
}

function close_db(db, workspace_id, cb) {
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
}

function finish_db(db, workspace_id) {
  let dbs_to_close = [];
  db.refcount--;
  if (db.refcount > 0) {
    return;
  }
  if (db.refcount < 0) {
    log.error("Refcount for %s is negative! This should never happen!", workspace_id);
  }
  db.finished_at = db.finished_at || Date.now();
  let open_dbs_len = _.size(open_dbs);
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
}

function get(maybe_db, workspace_id, key, encoding, cb) {
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
}

function read(maybe_db, workspace_id, start, end, encoding, cb) {
  const fin_db = _.once(finish_db);
  get_db(maybe_db, workspace_id, null, function (err, db) {
    if (err) {
      return cb(err);
    }
    const rs = db.createReadStream({
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
}

function del(maybe_db, workspace_id, key, cb) {
  get_db(maybe_db, workspace_id, null, function (err, db) {
    if (err) {
      return cb(err);
    }
    db.del(key, cb);
  });
}

function read_buf_content(db, workspace_id, cb) {
  return read(db, workspace_id, "buf_content_", "buf_content_999999999999", "binary", cb);
}

function read_buf_info(db, workspace_id, cb) {
  return read(db, workspace_id, "buf_", "buf_999999999999", "utf8", cb);
}

function read_events(db, workspace_id, cb) {
  return read(db, workspace_id, "event_", "event_999999999999", "utf8", cb);
}


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
  close_db,
  del,
  finish_db,
  get_db_path,
  get_db,
  get: get,
  open_dbs,
  read,
  read_buf_content,
  read_buf_info,
  read_events,
};
