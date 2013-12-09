var path = require("path");
var util = require("util");

var async = require("async");
var log = require("floorine");
var levelup = require("levelup");
var mkdirp = require("mkdirp");
var _ = require("lodash");

var db = require("db");
var settings = require("settings");


var migrate_room = function (db_room, cb) {
  db.client.query("SELECT * FROM room_buffer WHERE room_id = $1 AND deleted = FALSE", [db_room.id], function (err, result) {
    var nroom_path;

    room_path = path.normalize(path.join(settings.buf_storage.local.dir, db_room.id.toString(), "db"));

    if (err) {
      log.error("error getting buffers for room", db_room.id, err);
      process.nextTick(function () { cb(err, result); });
      return;
    }

    mkdirp(room_path, function (err) {
      if (err) {
        process.nextTick(function () { cb(err); });
        return;
      }
      levelup(room_path, { valueEncoding: "json" }, function (err, ldb) {
        if (err) {
          process.nextTick(function () { cb(err); });
          return;
        }
        log.log("%s: migrating %s buffers", db_room.id, result.rows.length);

        async.eachLimit(result.rows, 20, function (buf) {
          var buf_key,
            buf_obj;
          buf_key = util.format("buf_%s", buf.id);
          buf_obj = {
            id: buf.id,
            path: buf.path,
            fid: buf.fid,
            deleted: buf.deleted,
            md5: buf.md5,
            encoding: buf.encoding
          };
          ldb.put(buf_key, buf_obj);
        });
        return ldb.close(cb);
      });
    });
  });
};

db.connect(function (err, result) {
  if (err) {
    log.error("Error connecting to postgres:", err, result);
    process.exit(1);
  }

  db.client.query("SELECT * FROM room_room", function (err, result) {
    if (err) {
      log.error("error getting workspaces:", err);
      process.exit(1);
    }

    async.eachLimit(result.rows, 20, function (db_room, cb) {
      log.log("Migrating %s", db_room.id);
      migrate_room(db_room, cb);
    });
  });
});
