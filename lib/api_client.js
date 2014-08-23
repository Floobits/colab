/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var request = require("request");
var util = require("util");

var log = require("floorine");
var _ = require("lodash");

var perms = require("./perms");
var settings = require("./settings");
var utils = require("./utils");


request = request.defaults({
  auth: {
    "user": settings.django_user,
    "pass": settings.django_pass,
    "sendImmediately": true
  }
});

var perms_for_room = function (user_id, room_id, is_super, cb) {
  var url = util.format("%s/supersecret/r/%s/%s/perms", settings.django_base_url, user_id, room_id);

  if (is_super) {
    return cb(null, _.keys(perms.db_perms_mapping));
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

var perms_set = function (user_id, room_id, perms, cb) {
  var options = {
      json: {
        perms: perms
      }
    },
    url = util.format("%s/supersecret/r/%s/%s/perms", settings.django_base_url, user_id, room_id);

  log.debug("Setting perms %s. URL %s", perms, url);
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

var user_auth = function (auth_data, cb) {
  var options = {
      json: {
        auth_data: auth_data
      }
    },
    url = util.format("%s/supersecret/auth", settings.django_base_url);

  request.get(url, options, function (error, response, body) {
    if (error) {
      return cb(error);
    }
    if (response.statusCode >= 400) {
      // TODO: better error message
      return cb(util.format("Code %s from django. Go check the django logs for %s", response.statusCode, url));
    }
    return cb(null, body);
  });
};

var user_create = function (username, cb) {
  var options = {
      json: {
        username: username
      }
    },
    url = util.format("%s/supersecret/u/create", settings.django_base_url);

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

var workspace_get = function (owner, name, cb) {
  var url = util.format("%s/api/workspace/%s/%s", settings.django_base_url, owner, name);

  log.debug("Getting workspace. URL:", url);
  request.get(url, function (error, response, body) {
    var workspace;

    if (error) {
      return cb(error);
    }
    if (response.statusCode >= 400) {
      return cb(util.format("Code %s from django. Go check the django logs for %s", response.statusCode, url));
    }
    try {
      workspace = JSON.parse(body);
    } catch (e) {
      return cb(e);
    }

    return cb(null, workspace);
  });
};

var workspace_set = function (id, data, cb) {
  var url = util.format("%s/supersecret/r/%s", settings.django_base_url, id),
    options = {
      json: data
    };

  log.debug("Setting workspace. URL:", url);
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
  perms_for_room: perms_for_room,
  perms_set: perms_set,
  user_auth: user_auth,
  user_create: user_create,
  workspace_get: workspace_get,
  workspace_set: workspace_set
};
