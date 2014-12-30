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

var log_err = function (url, response, body) {
  log.warn("Code %s from django. Go check the django logs for %s", response.statusCode, url);
  log.debug("Response body: %s", body);
};

var handle_response = function (url, cb, error, response, body) {
  if (error) {
    return cb(error);
  }
  if (response.statusCode >= 400) {
    if (_.isObject(body)) {
      body = JSON.stringify(body);
    }
    log_err(url, response, body);
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

  log.debug("Setting workspace. URL: %s. JSON: %s", url, JSON.stringify(options.json));
  request.post(url, options,  handle_response.bind(null, url, cb));
};

var solicitation_charge = function (id, data, cb) {
  var url = util.format("%s/api/contracting/solicitation/%s/charge", settings.django_base_url, id),
    options = {
      json: data
    };

  log.debug("Charging solicitation. URL: %s. JSON: %s", url, JSON.stringify(options.json));
  request.post(url, options, handle_response.bind(null, url, cb));
};

var solicitation_create = function (data, cb) {
  var url = util.format("%s/api/contracting/solicitation", settings.django_base_url),
    options = {
      json: data
    };

  log.debug("Creating solicitation. URL: %s. JSON: %s", url, JSON.stringify(options.json));
  request.post(url, options, handle_response.bind(null, url, cb));
};

var solicitation_set = function (id, data, cb) {
  var url = util.format("%s/api/contracting/solicitation/%s", settings.django_base_url, id),
    options = {
      json: data
    };

  log.debug("Setting solicitation. URL: %s. JSON: %s", url, JSON.stringify(options.json));
  request.patch(url, options, handle_response.bind(null, url, cb));
};

var feedback_create = function (data, cb) {
  var url = util.format("%s/api/contracting/feedback", settings.django_base_url),
    options = {
      json: data
    };

  log.debug("Creating feedback. URL: %s. JSON: %s", url, JSON.stringify(options.json));
  request.post(url, options, handle_response.bind(null, url, cb));
};


module.exports = {
  feedback_create: feedback_create,
  perms_for_room: perms_for_room,
  perms_set: perms_set,
  solicitation_charge: solicitation_charge,
  solicitation_create: solicitation_create,
  solicitation_set: solicitation_set,
  user_auth: user_auth,
  user_create: user_create,
  workspace_get: workspace_get,
  workspace_set: workspace_set,
};
