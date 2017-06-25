# Colab Node.js Socket.io Diff-Match-Patch Awesomeness

## Setup

* Install dependencies in setup/apt.txt
* `npm install`
* `cd lib/`, copy `settings.js.example` to `settings.js`. Modify to suit.
* `npm start`


### Messaging

Colabs all connect to the master. Solicitation events are forwarded to the master. Master updates DB. Solicitation events aren't acked until DB is updated and master acks.

Replace HTTP polling. Colabs send their workspace state on initial connect to master. Send diffs on the connection as workspace versions update.


### One day...

Raft or Paxos master election.
Real time streaming replication.


### Concerns

What if two colabs can talk to master but not each other?
