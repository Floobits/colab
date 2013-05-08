var request = require('request');
var util = require('util');

var _ = require('underscore');

var settings = require('./settings');
var utils = require('./utils');


var for_room = function (user_id, room_id, is_super, cb) {
  var url = util.format('http://floobits.com/supersecret/r/%s/%s/perms/', room_id, user_id),
    allowed_actions = {};

  if (is_super) {
     _.each(utils.db_perms_mapping, function (perms, codename) {
       allowed_actions[codename] = 1;
     });

    return cb(null, _.keys(allowed_actions));
  }
  request.auth(settings.django_user, settings.django_pass, true).get(url, function (error, response, body) {
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
