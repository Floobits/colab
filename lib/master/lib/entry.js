/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

process.on("uncaughtException", function (err) {
  console.error(err.stack);
  process.exit(1);
});

exports.run = function run() {
  require("./server").run();
};
