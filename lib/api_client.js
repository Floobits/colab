"use strict";

let request = require("request");
const util = require("util");

const log = require("floorine");
const _ = require("lodash");

const perms = require("./perms");
const settings = require("./settings");


request = request.defaults(_.merge(settings.request_defaults, {
  auth: {
    user: settings.django_user,
    pass: settings.django_pass,
  }
}));

function fallback_err_msg(response) {
  return util.format("Code %s from internal API.", response.statusCode);
}

function log_err(url, response, body) {
  log.warn("Code %s from django. Go check the django logs for %s", response.statusCode, url);
  log.debug("Response body: %s", body);
}

function handle_response(url, cb, error, response, body) {
  if (error) {
    return cb(error);
  }
  if (response.statusCode >= 400) {
    if (_.isObject(body)) {
      if (_.isString(body.message)) {
        body = body.message;
      } else {
        body = JSON.stringify(body);
      }
    }
    log_err(url, response, body);
    return cb(body || fallback_err_msg(response), response);
  }
  return cb(null, body);
}

function handle_response_get(url, cb, error, response, body) {
  var parsed_body;

  if (error) {
    return cb(error);
  }
  if (response.statusCode >= 400) {
    log_err(url, response);
    return cb(body || fallback_err_msg(response), response);
  }
  try {
    parsed_body = JSON.parse(body);
  } catch (e) {
    return cb(e, body);
  }
  return cb(null, parsed_body);
}

function perms_for_room(username, room_id, is_super, cb) {
  var url = util.format("%s/supersecret/r/%s/%s/perms", settings.django_base_url, room_id, username);

  if (is_super) {
    return cb(null, {perms: _.keys(perms.db_perms_mapping)});
  }

  log.debug("Getting perms. URL:", url);
  request.get(url, handle_response_get.bind(null, url, cb));
}

function perms_set(username, room_id, room_perms, cb) {
  var options = {
      json: {
        perms: room_perms
      }
    },
    url = util.format("%s/supersecret/r/%s/%s/perms", settings.django_base_url, room_id, username);
  log.debug("Setting perms %s. URL %s", room_perms, url);
  request.post(url, options, handle_response.bind(null, url, cb));
}

function user_auth(auth_data, cb) {
  var options = {
      json: {
        auth_data: auth_data
      }
    },
    url = util.format("%s/supersecret/auth", settings.django_base_url);
  log.debug("Authing user %s. URL %s", auth_data.username, url);
  request.get(url, options, handle_response.bind(null, url, cb));
}

function user_create(user_info, cb) {
  var options = {
      json: {
        username: user_info.username,
        password: user_info.password,
        email: user_info.email,
      }
    },
    url = util.format("%s/supersecret/u/create", settings.django_base_url);
  log.debug("Creating user. URL: %s. Desired username: %s", url, user_info.username);
  request.post(url, options, handle_response.bind(null, url, cb));
}

function workspace_get(owner, name, cb) {
  var url;

  if (name) {
    url = util.format("%s/api/workspace/%s/%s", settings.django_base_url, owner, name);
  } else {
    url = util.format("%s/api/workspace/%s", settings.django_base_url, owner);
  }

  log.debug("Getting workspace. URL:", url);
  request.get(url, handle_response_get.bind(null, url, cb));
}

function workspace_get_by_id(workspace_id, cb) {
  var url = util.format("%s/supersecret/r/%s", settings.django_base_url, workspace_id);

  log.debug("Getting workspace by id. URL:", url);
  request.get(url, handle_response_get.bind(null, url, cb));
}

function workspace_set(id, data, cb) {
  var url = util.format("%s/supersecret/r/%s", settings.django_base_url, id),
    options = {
      json: data
    };

  log.debug("Setting workspace. URL: %s. JSON: %s", url, JSON.stringify(options.json));
  request.post(url, options, handle_response.bind(null, url, cb));
}

function solicitation_charge(id, data, cb) {
  var url = util.format("%s/api/contracting/solicitation/%s/charge", settings.django_base_url, id),
    options = {
      json: data
    };

  log.debug("Charging solicitation. URL: %s. JSON: %s", url, JSON.stringify(options.json));
  request.post(url, options, handle_response.bind(null, url, cb));
}

function solicitation_create(data, cb) {
  var url = util.format("%s/api/contracting/solicitation", settings.django_base_url),
    options = {
      json: data
    };

  log.debug("Creating solicitation. URL: %s. JSON: %s", url, JSON.stringify(options.json));
  request.post(url, options, handle_response.bind(null, url, cb));
}

function solicitation_set(id, data, cb) {
  var url = util.format("%s/api/contracting/solicitation/%s", settings.django_base_url, id),
    options = {
      json: data
    };
  log.debug("Setting solicitation. URL: %s. JSON: %s", url, JSON.stringify(options.json));
  request.patch(url, options, handle_response.bind(null, url, cb));
}

function solicitations_get(owner, name, cb) {
  let url = util.format("%s/api/workspace/%s/%s/solicitations", settings.django_base_url, owner, name);

  log.debug("Getting solicitations for workspace %s/%s. URL: %s.", owner, name, url);
  request.get(url, handle_response_get.bind(null, url, cb));
}

function solicitations_get_active(since, cb) {
  let url = util.format("%s/api/solicitations/active?created_at=%s", settings.django_base_url, since);

  log.debug("Getting active solicitations. URL: %s.", url);
  request.get(url, handle_response_get.bind(null, url, cb));
}

function feedback_create(data, cb) {
  var url = util.format("%s/api/contracting/feedback", settings.django_base_url),
    options = {
      json: data
    };

  log.debug("Creating feedback. URL: %s. JSON: %s", url, JSON.stringify(options.json));
  request.post(url, options, handle_response.bind(null, url, cb));
}

function verify_charge(username, cb) {
  const url = util.format("%s/api/contracting/verify", settings.django_base_url);
  const options = {
    json: {
      username: username,
    },
  };

  log.debug("Verifying charge. URL: %s. JSON: %s", url, JSON.stringify(options.json));
  request.post(url, options, handle_response.bind(null, url, cb));
}

module.exports = {
  feedback_create,
  perms_for_room,
  perms_set,
  solicitation_charge,
  solicitation_create,
  solicitation_set,
  solicitations_get,
  solicitations_get_active,
  user_auth,
  user_create,
  verify_charge,
  workspace_get,
  workspace_get_by_id,
  workspace_set,
};
