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


# Grand Unification of Colab Stuff

Move controller code into colab. For now, designate one colab as the master.

Master is still the one to update memcache, tell balancers which colab to connect to, etc.


### Messaging

Colabs all connect to the master. Solicitation events are forwarded to the master. Master updates DB. Solicitation events aren't acked until DB is updated and master acks.

Replace HTTP polling. Colabs send their workspace state on initial connect to master. Send diffs on the connection as workspace versions update.


### One day...

Raft or Paxos master election.
Real time streaming replication.



### Concerns

What if two colabs can talk to master but not each other?
