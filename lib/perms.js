var request = require("request");
var util = require("util");

var _ = require("underscore");

var settings = require("./settings");
var utils = require("./utils");


var db_perms_mapping = {
  "view_room": ["get_buf", "request_perms"],
  "edit_room": ["patch", "get_buf", "create_buf", "delete_buf", "rename_buf",
                "set_temp_data", "delete_temp_data",
                "highlight", "msg",
                "create_term", "delete_term", "update_term", "term_stdout", "saved"],
  "admin_room": ["kick", "pull_repo", "term_stdin", "perms"]
};

var for_room = function (user_id, room_id, is_super, cb) {
  var perms = [],
    options,
    url = util.format("%s/supersecret/r/%s/%s/perms/", settings.django_base_url, user_id, room_id);

  if (is_super) {
    _.each(db_perms_mapping, function (perms_for_codename, codename) {
      perms = perms.concat(perms_for_codename);
    });
    return cb(null, _.uniq(perms));
  }

  options = {
    auth: {
      "user": settings.django_user,
      "pass": settings.django_pass,
      "sendImmediately": true
    }
  };

  request.get(url, options, function (error, response, body) {
    var fine_grained_perms = [],
      perms;

    if (error) {
      return cb(error);
    }
    if (response.statusCode >= 400) {
      return cb(util.format("Code %s from django. Go check the django logs for %s", response.statusCode, url));
    }
    try {
      perms = JSON.parse(body);
    } catch (e) {
      return cb(e);
    }

    _.each(perms, function (perm) {
      fine_grained_perms = fine_grained_perms.concat(db_perms_mapping[perm]);
    });

    return cb(null, _.uniq(fine_grained_perms));
  });
};

module.exports = {
  db_perms_mapping: db_perms_mapping,
  for_room: for_room
};
