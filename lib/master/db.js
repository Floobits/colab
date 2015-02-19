/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var pg = require("pg");
var log = require("floorine");
var _ = require("lodash");

var settings = require("../settings");


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
  } catch (e) {
    log.error("Error closing DB connections:", e);
  }
  log.log("Done closing DB connections.");
}

function get_user(username, cb) {
  query("SELECT * FROM auth_user WHERE username = $1", [username], function (err, result) {
    if (err) {
      log.error("error getting user", username, err);
      return cb(err, result);
    }
    if (parseInt(result.rowCount, 10) !== 1) {
      return cb("User not found", result);
    }
    return cb(err, result.rows[0]);
  });
}

function get_user_by_api_key(api_key, cb) {
  query("SELECT * FROM auth_user WHERE id IN (SELECT user_id from floobits_userprofile WHERE api_key = $1)",
    [api_key],
    function (err, result) {
      if (err) {
        return cb(err, result);
      }
      if (parseInt(result.rowCount, 10) !== 1) {
        return cb("Invalid API key or secret", result);
      }
      return cb(undefined, result.rows[0]);
    });
}

function auth_user(user_id, secret, cb) {
  query("SELECT secret, user_id FROM floobits_userprofile WHERE user_id = $1 AND secret = $2",
    [user_id, secret],
    function (err, result) {
      if (err) {
        return cb(err, result);
      }
      if (parseInt(result.rowCount, 10) !== 1) {
        return cb("Invalid username or secret", result);
      }
      return cb(undefined, result.rows[0]);
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
      if (parseInt(result.rowCount, 10) !== 1) {
        return cb(util.format("Workspace %s/%s not found.", user.username, name), result);
      }
      return cb(err, result.rows[0]);
    });
  });
}


module.exports = {
  end: end,
  get_user: get_user,
  get_user_by_api_key: get_user_by_api_key,
  auth_user: auth_user,
  get_workspace: get_workspace,
  query: query
};
