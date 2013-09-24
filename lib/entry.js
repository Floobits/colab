process.on("uncaughtException", function (err) {
  console.error(err.stack);
  process.exit(1);
});

exports.run = function run() {
  require("./server").run();
};
