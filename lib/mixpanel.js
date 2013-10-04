var log = require("floorine");
var _ = require("lodash");
var Mixpanel = require("mixpanel");

var settings = require("./settings");


var d = require("domain").create(),
  mixpanel;

if (settings.MIXPANEL_TOKEN) {
  mixpanel = Mixpanel.init(settings.MIXPANEL_TOKEN);
} else {
  mixpanel = {
    people: {
      increment: function () {},
      set: function () {}
    },
    track: function () {}
  };
}

d.on("error", function (err) {
  console.log("Error in mixpanel:", err.message);
});

_.each(mixpanel, function (v, k) {
  if (!_.isFunction(v)) {
    return;
  }
  mixpanel[k] = function () {
    var args = Array.prototype.slice.call(arguments);
    d.run(function () {
      v.apply(mixpanel, args);
    });
  };
});

module.exports = mixpanel;
