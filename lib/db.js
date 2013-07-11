var util = require("util");

var pg = require("pg").native;
var _ = require("underscore");

var log = require("./log");
var settings = require("./settings");

var client;

var buf_encodings_mapping = {
  0: "utf8",
  1: "base64"
};

var buf_encodings_reverse = _.invert(buf_encodings_mapping);

function connect(cb) {
  client = new pg.Client(settings.db_info);

  client.connect(function (err, result) {
    module.exports.client = client;

    client.on("error", function (err) {
      log.error("Postgres error:", err);
      process.exit(1);
    });

    client.on("notice", function (notice) {
      log.error("Postgres notice:", notice);
      process.exit(1);
    });

    if (cb) {
      cb(err, result);
    }
  });
}

function get_user(username, cb) {
  client.query("SELECT * FROM auth_user WHERE username = $1", [username], function (err, result) {
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

function get_room(owner, name, cb) {
  get_user(owner, function (err, user) {
    if (err) {
      return cb(err, user);
    }
    return client.query("SELECT * FROM room_room WHERE user_id = $1 AND name = $2", [user.id, name], function (err, result) {
      if (err) {
        return cb(err, result);
      }
      if (result.rowCount !== 1) {
        return cb(util.format("Workspace %s/%s not found.", user.username, name));
      }
      return cb(err, result.rows[0]);
    });
  });
}

function auth_user(user_id, secret, cb) {
  client.query("SELECT secret, user_id FROM floobits_userprofile WHERE user_id = $1 AND secret = $2",
    [user_id, secret],
    function (err, result) {
      if (err) {
        return cb(err, result);
      }
      if (result.rowCount !== 1) {
        return cb("Invalid username or secret", result);
      }
      return cb(undefined, result.rows[0]);
    });
}

module.exports = {
  connect: connect,
  buf_encodings_mapping: buf_encodings_mapping,
  buf_encodings_reverse: buf_encodings_reverse,
  get_room: get_room,
  auth_user: auth_user,
  get_user: get_user
};
