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

var get = function (key, value, cb) {
  cb = cb || function () {};
  log.debug(util.format("Getting key %s", key));
  client.get(key, cb);
};

var set = function (key, value, opts, cb) {
  opts = opts || {
    flags: 0,
    exptime: 0
  };
  cb = cb || function (err, result) {
    if (err) {
      log.error("Error setting key", key, ":", err);
    } else {
      log.debug("Successfully set", key);
    }
  };
  log.debug(util.format("Setting key %s to %s", key, value));
  client.set(key, value, opts, cb);
};

module.exports = {
  client: client,
  connect: connect,
  get: get,
  set: set
};
