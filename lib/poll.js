var util = require("util");

var async = require("async");
var log = require("floorine");
var request = require("request");
var _ = require("lodash");

var settings = require("./settings");

request = request.defaults({
  sendImmediately: true
});


var ColabPoller = function (colab) {
  var self = this;

  self.colab = colab;
  self.interval_id = null;
  self.errors = 0;
  self.should_poll = false;
};


ColabPoller.prototype.start = function (cb) {
  var self = this;

  self.should_poll = true;
  self.poll(cb);
};


ColabPoller.prototype.stop = function () {
  var self = this;

  log.log("Stopping polling...");
  self.should_poll = false;

  if (self.interval_id) {
    clearTimeout(self.interval_id);
    self.interval_id = null;
    log.log("Stopped polling.");
  }
};


ColabPoller.prototype.poll = function (cb) {
  var self = this,
    options = {
      json: true,
      rejectUnauthorized: false,
      timeout: 10000
    },
    start = Date.now(),
    url = util.format("%s://%s:%s/workspaces/all/", "http", self.colab.ip, self.colab.metrics_port);

  self.interval_id = null;

  cb = cb || function (err) {
    if (err) {
      log.error(err);
    }
  };

  log.debug("Hitting", url);

  request.get(url, options, function (err, response, body) {
    var end,
      interval;

    log.debug("Got response from %s", url);

    if (!err && response.statusCode >= 400) {
      err = util.format("Status code %s from %s", response.statusCode, url);
    }

    if (err) {
      self.errors++;
    } else {
      if (!!self.colab.id && self.colab.id !== body.server_id) {
        log.error("Server ID changed from %s to %s!", self.colab.id, body.server_id);
      }
      self.colab.id = body.server_id;

      self.colab.update_workspace_counts(body);

      log.log("Successfully polled %s", self.colab.toString());
      self.errors = 0;
    }

    end = Date.now();
    interval = Math.min(settings.poll_interval - (end - start), settings.poll_interval);
    log.debug("Polling again in %s seconds", interval / 1000);

    if (self.interval_id) {
      clearTimeout(self.interval_id);
      self.interval_id = null;
    }

    if (self.should_poll) {
      self.interval_id = setTimeout(self.poll.bind(self), interval);
    }

    return cb(err);
  });
};


module.exports = {
  ColabPoller: ColabPoller
};
