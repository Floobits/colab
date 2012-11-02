var child_process = require('child_process');

var optimist = require('optimist');
var path = require('path');
var fs = require('fs');

process.on('uncaughtException', function (err) {
  console.error(err.stack);
});

exports.run = function run() {
  require('./server').run();
};