# Colab Node.js Socket.io Diff-Match-Patch Awesomeness

## Setup

* Install dependencies in setup/apt.txt
* `npm install`
* `cd lib/`, copy `settings.js.example` to `settings.js`. Modify to suit.
* `npm start`


echo "deb http://stable.packages.cloudmonitoring.rackspace.com/ubuntu-12.04-x86_64 cloudmonitoring main" > /etc/apt/sources.list.d/rackspace-monitoring-agent.list
curl https://monitoring.api.rackspacecloud.com/pki/agent/linux.asc | sudo apt-key add -
sudo apt-get update
sudo apt-get install rackspace-monitoring-agent
sudo rackspace-monitoring-agent --setup
# New Entity Created: en7xaYDhPQ
sudo mkdir /usr/lib/rackspace-monitoring-agent/plugins
echo "/usr/bin/curl http://localhost:81/$1" > /usr/lib/rackspace-monitoring-agent/plugins/node-stats.sh
sudo chmod +x /usr/lib/rackspace-monitoring-agent/plugins/node-stats.sh
