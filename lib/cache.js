var util = require("util");

var _ = require("lodash");
var mc = require("mc");

var log = require("./log");
var settings = require("./settings");


var client = new mc.Client(settings.cache_servers, mc.Adapter.json);

var connect = function (cb) {
  log.log("Connecting to memcached...");
  client.connect(function (err, result) {
    if (err) {
      log.error("Error connecting to memcached:", err);
    } else {
      log.log("Connected to memcached!");
    }
    cb(err, result);
  });
};

var default_cb = function (action, key) {
  return function (err, result) {
    if (err) {
      log.error(util.format("Cache error. %s key %s: %s", action, key, err));
    } else {
      log.debug(util.format("Successfully %s key %s", action, key));
    }
  };
};

var del = function (key, cb) {
  cb = cb || default_cb("delete", key);
  client.del(key, cb);
};

var get = function (key, value, cb) {
  cb = cb || default_cb("get", key);
  log.debug(util.format("Getting key %s", key));
  client.get(key, cb);
};

var set = function (key, value, opts, cb) {
  opts = opts || {
    flags: 0,
    exptime: 0
  };
  cb = cb || default_cb("set", key);

  log.debug(util.format("Setting key %s to %s", key, value));
  client.set(key, value, opts, cb);
};

module.exports = {
  client: client,
  connect: connect,
  del: del,
  get: get,
  set: set
};
