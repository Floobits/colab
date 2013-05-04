var MSG = function (agent, msg) {
  var self = this;

  self.user_id = agent.id;
  self.username = agent.username;
  self.time = Date.now()/1000;
  self.data = msg;
};

MSG.prototype.to_json = function () {
  var self = this;

  return {
    user_id: self.user_id,
    username: self.username,
    time: self.time,
    data: self.data
  };
};

module.exports = MSG;
