var pg = require("pg");

var log = require("./log");
var settings = require("./settings");

var client;

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

function get_perms(user_id, room_id, cb) {
  client.query("SELECT id FROM django_content_type WHERE model = $1", ["room"], function (err, result) {
    if (result.rowCount !== 1) {
      return cb("Room content type not found!");
    }
    var ct_id = result.rows[0].id;
    return client.query("SELECT codename FROM auth_permission WHERE id in (SELECT permission_id FROM guardian_userobjectpermission WHERE content_type_id = $1 AND (user_id = $2 OR user_id = -1) AND object_pk = $3)",
      [ct_id, user_id, room_id],
      function (err, result) {
        if (err) {
          return cb(err, result);
        }
        return cb(err, result.rows);
      }
    );
  });
}

function get_room(owner, name, cb) {
  get_user(owner, function (err, user) {
    if (err) {
      return cb(err, user);
    }
    client.query("SELECT * FROM room_room WHERE user_id = $1 AND name = $2", [user.id, name], function (err, result) {
      if (err) {
        return cb(err, result);
      }
      if (result.rowCount !== 1) {
        return cb("Room not found. user id", user.id, "name", name);
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
        return cb("User or secret invalid", result);
      }
      return cb(undefined, result.rows[0]);
    }
  );
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
  connect: connect,
  get_perms: get_perms,
  get_room: get_room,
  auth_user: auth_user,
  get_user: get_user
};
