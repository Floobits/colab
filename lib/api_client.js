/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var request = require("request");
var util = require("util");

var log = require("floorine");
var _ = require("lodash");

var perms = require("./perms");
var settings = require("./settings");
var utils = require("./utils");


request = request.defaults(_.merge(settings.request_defaults, {
  auth: {
    user: settings.django_user,
    pass: settings.django_pass
  }
}));

var fallback_err_msg = function (response) {
  return util.format("Code %s from internal API.", response.statusCode);
};

var log_err = function (url, response) {
  log.warn(util.format("Code %s from django. Go check the django logs for %s", response.statusCode, url));
};

var handle_response = function (url, cb, error, response, body) {
  if (error) {
    return cb(error);
  }
  if (response.statusCode >= 400) {
    log_err(url, response);
    if (_.isObject(body)) {
      body = JSON.stringify(body);
    }
    return cb(body || fallback_err_msg(response));
  }
  return cb(null, body);
};

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
      log_err(url, response);
      return cb(body || fallback_err_msg(response));
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
  request.post(url, options, handle_response.bind(null, url, cb));
};

var user_auth = function (auth_data, cb) {
  var options = {
      json: {
        auth_data: auth_data
      }
    },
    url = util.format("%s/supersecret/auth", settings.django_base_url);
  log.debug("Authing user %s. URL %s", auth_data.username, url);
  request.get(url, options, handle_response.bind(null, url, cb));
};

var user_create = function (username, cb) {
  var options = {
      json: {
        username: username
      }
    },
    url = util.format("%s/supersecret/u/create", settings.django_base_url);
  log.debug("Creating user. URL: %s. Desired username: %s", url, username);
  request.post(url, options,  handle_response.bind(null, url, cb));
};

var workspace_get = function (owner, name, cb) {
  var url;

  if (name) {
    url = util.format("%s/api/workspace/%s/%s", settings.django_base_url, owner, name);
  } else {
    url = util.format("%s/api/workspace/%s", settings.django_base_url, owner);
  }

  log.debug("Getting workspace. URL:", url);
  request.get(url, function (error, response, body) {
    var workspace;

    if (error) {
      return cb(error);
    }
    if (response.statusCode >= 400) {
      log_err(url, response);
      return cb(body || fallback_err_msg(response));
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
  request.post(url, options,  handle_response.bind(null, url, cb));
};


module.exports = {
  perms_for_room: perms_for_room,
  perms_set: perms_set,
  user_auth: user_auth,
  user_create: user_create,
  workspace_get: workspace_get,
  workspace_set: workspace_set
};
