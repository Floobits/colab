var request = require("request");
var util = require("util");

var _ = require("lodash");

var log = require("./log");
var settings = require("./settings");
var utils = require("./utils");


var db_perms_mapping = {
  "view_room": ["get_buf", "request_perms"],
  "edit_room": ["patch", "get_buf", "set_buf", "create_buf", "delete_buf", "rename_buf",
                "set_temp_data", "delete_temp_data",
                "highlight", "msg",
                "create_term", "delete_term", "update_term", "term_stdout", "saved"],
  "admin_room": ["kick", "pull_repo", "term_stdin", "perms"]
};

var all_perms = _.uniq(_.values(db_perms_mapping));

request = request.defaults({
  auth: {
    "user": settings.django_user,
    "pass": settings.django_pass,
    "sendImmediately": true
  }
});

var fine_grained_perms = function (perms_list) {
  fine_grained_perms = [];

  _.each(perms_list, function (perm) {
    fine_grained_perms = fine_grained_perms.concat(db_perms_mapping[perm]);
  });

  return _.uniq(fine_grained_perms);
};

var for_room = function (user_id, room_id, is_super, cb) {
  var perms = [],
    url = util.format("%s/supersecret/r/%s/%s/perms/", settings.django_base_url, user_id, room_id);

  if (is_super) {
    return cb(null, _.keys(db_perms_mapping));
  }

  log.debug("Getting perms. URL:", url);
  request.get(url, function (error, response, body) {
    var perms;

    if (error) {
      return cb(error);
    }
    if (response.statusCode >= 400) {
      return cb(util.format("Code %s from django. Go check the django logs for %s", response.statusCode, url));
    }
    try {
      perms = JSON.parse(body).perms;
    } catch (e) {
      return cb(e);
    }

    return cb(null, perms);
  });
};

var set = function (user_id, room_id, perms, cb) {
  var options = {
      json: {
        perms: perms
      }
    },
    url = util.format("%s/supersecret/r/%s/%s/perms/", settings.django_base_url, user_id, room_id);

  log.debug("Setting perms. URL:", url);
  request.post(url, options, function (error, response, body) {
    if (error) {
      return cb(error);
    }
    if (response.statusCode >= 400) {
      return cb(util.format("Code %s from django. Go check the django logs for %s", response.statusCode, url));
    }

    return cb(null, body);
  });
};

var create_user = function (username, cb) {
  var options = {
      json: {
        username: username
      }
    },
    url = util.format("%s/supersecret/u/create/", settings.django_base_url);

  log.debug("Creating user. URL:", url, "Desired username:", username);
  request.post(url, options, function (error, response, body) {
    if (error) {
      return cb(error);
    }
    if (response.statusCode >= 400) {
      return cb(util.format("Code %s from django. Go check the django logs for %s", response.statusCode, url));
    }

    return cb(null, body);
  });
};

module.exports = {
  all_perms: all_perms,
  create_user: create_user,
  db_perms_mapping: db_perms_mapping,
  fine_grained_perms: fine_grained_perms,
  for_room: for_room,
  set: set
};
