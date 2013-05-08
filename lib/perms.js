var request = require('request');
var util = require('util');

var _ = require('underscore');

var settings = require('./settings');
var utils = require('./utils');


var for_room = function (user_id, room_id, is_super, cb) {
  var url = util.format('%s/supersecret/r/%s/%s/perms/', settings.django_base_url, user_id, room_id),
    allowed_actions = {},
    options;

  if (is_super) {
     _.each(utils.db_perms_mapping, function (perms, codename) {
       allowed_actions[codename] = 1;
     });

    return cb(null, _.keys(allowed_actions));
  }

  options = { auth: {
      'user': settings.django_user,
      'pass': settings.django_pass,
      'sendImmediately': true
    }
  };

  request.get(url, options, function (error, response, body) {
    var perms;

    if (response.statusCode >= 400) {
      return cb('oh shit');
    }
    try {
      perms = JSON.parse(body);
    } catch (e) {
      return cb(e);
    }

    _.each(perms, function (codename) {
      allowed_actions[codename] = 1;
    });

    return cb(null, _.keys(allowed_actions));
  });
};

module.exports = {
  for_room: for_room
};
