var pg = require("pg");

var log = require("./log");

var client = new pg.Client({
  user: "floobits",
  password: "",
  database: "floobits",
  host: "/var/run/postgresql"
});

client.connect(function (err, result) {
  if (err) {
    log.error("Error connecting to postgres:", err);
    process.exit(1);
  }
});

function get_room(owner, name, cb) {
  get_user(owner, function (err, user) {
    client.query("SELECT * FROM room_room WHERE user_id = $1 AND name = $2", [user.id, name], function (err, result) {
      if (result.rowCount != 1) {
        return cb("Room not found. user id", user.id, "name", name);
      }
      cb(err, result.rows[0]);
    });
  });
}

function auth_user(username, secret, cb) {
  get_user(username, function (err, result) {
    if (err) {
      // User not found.
      return cb(err, result);
    }
    //TODO: check secret against password
    cb(undefined, result);
  });
}

function get_user(username, cb) {
  client.query("SELECT * FROM auth_user WHERE username = $1", [username], function (err, result) {
    if (err) {
      log.error("error getting user", username, err);
      return cb(err, result);
    } else if (result.rowCount != 1) {
      return cb("User not found", result);
    }
    return cb(err, result.rows[0]);
  });
}

module.exports = {
  get_room: get_room,
  auth_user: auth_user,
  get_user: get_user,
  client: client
};
