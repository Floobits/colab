Stuff for later

Encrypt leveldb with random AES key. Rebooting will effectively lose data, but that's ok since we're using instance storage
options:
  use node's transform streams + crypto
    http://codewinds.com/blog/2013-08-20-nodejs-transform-streams.html
    http://nodejs.org/api/crypto.html
  dm-crypt

streaming replication instead of periodic snapshotting

use symlink trick so that these are atomic
if workspace is active, NEVER update from another colab server

what to do when in the middle of fetching from another colab but someone connects?
  wait until done, then let them connect
  show them all old bufs
  show them currently-updated bufs. if they haven't changed the old bufs, update those once we get them

TODO
prune script (for deleting workspaces that were deleted when a server was down)


test creating users from editor
pull from github repo
test with intellij (tls cipher suites may differ)

Upgrade notes:

before:

    wget https://iojs.org/dist/v1.3.0/iojs-v1.3.0.tar.gz
    tar xzf iojs-v1.3.0.tar.gz
    cd iojs-v1.3.0/
    ./configure
    make

change /service/colab/run to `exec node /data/colab/bin/colab 2>&1`

bring everything down

remove legacy node js stuff:

    sudo add-apt-repository --remove ppa:chris-lea/node.js
    sudo apt-get purge nodejs

install iojs 1.2 on everything

    cd iojs-v1.3.0/
    sudo make install
    sudo npm update -g

remove `node_modules`

update local_settings.js (add master's info)
remove colabcontroller from mdb00
install colab on mdb00

upgrade colabalancers

still need to test backup stuff
