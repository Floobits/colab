var request = require("request");
var util = require("util");

var _ = require("underscore");

var settings = require("./settings");
var utils = require("./utils");


var for_room = function (user_id, room_id, is_super, cb) {
  var allowed_actions = [],
    options,
    url = util.format("%s/supersecret/r/%s/%s/perms/", settings.django_base_url, user_id, room_id);

  if (is_super) {
     _.each(utils.db_perms_mapping, function (perms, codename) {
       allowed_actions = allowed_actions.concat(perms);
     });
    return cb(null, _.uniq(allowed_actions));
  }

  options = { auth: {
      "user": settings.django_user,
      "pass": settings.django_pass,
      "sendImmediately": true
    }
  };

  request.get(url, options, function (error, response, body) {
    var perms;

    if (response.statusCode >= 400) {
      return cb(util.format("Code %s from django. Go check the django logs for %s", response.statusCode, url));
    }
    try {
      perms = JSON.parse(body);
    } catch (e) {
      return cb(e);
    }

     _.each(perms, function (perm) {
       allowed_actions = allowed_actions.concat(utils.db_perms_mapping[perm]);
     });

    return cb(null, _.uniq(allowed_actions));
  });
};

module.exports = {
  for_room: for_room
};
