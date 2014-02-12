/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";
var util = require("util");

var pg = require("pg").native;
var log = require("floorine");
var _ = require("lodash");

var settings = require("./settings");


pg.on("error", function (err, client) {
  log.error("Postgres error from client %s: %s", client, err);
});
pg.on("notice", function (notice, client) {
  log.warn("Postgres notice from client %s: %s", client, notice);
});

function query(q, args, cb) {
  if (_.isFunction(args)) {
    cb = args;
  }
  pg.connect(settings.db_info, function (err, client, done) {
    if (err) {
      done();
      return cb(err);
    }
    client.query(q, args, function (err, result) {
      done();
      return cb(err, result);
    });
  });
}

function end() {
  log.log("Closing DB connections...");
  try {
    pg.end();
  } catch (ignore) {}
  log.log("Done closing DB connections.");
}

function get_user(username, cb) {
  query("SELECT * FROM auth_user WHERE username = $1", [username], function (err, result) {
    if (err) {
      log.error("error getting user", username, err);
      return cb(err, result);
    }
    if (result.rowCount !== 1) {
      return cb("User not found", result);
    }
    return cb(err, result.rows[0]);
  });
}

function get_workspace(owner, name, cb) {
  get_user(owner, function (err, user) {
    if (err) {
      return cb(err, user);
    }
    return query("SELECT * FROM room_room WHERE user_id = $1 AND name = $2", [user.id, name], function (err, result) {
      if (err) {
        return cb(err, result);
      }
      if (result.rowCount !== 1) {
        return cb(util.format("Workspace %s/%s not found.", user.username, name), result);
      }
      return cb(err, result.rows[0]);
    });
  });
}

module.exports = {
  end: end,
  get_user: get_user,
  get_workspace: get_workspace,
  query: query
};
