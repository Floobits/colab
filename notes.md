Stuff for later

Encrypt leveldb with random AES key. Rebooting will effectively lose data, but that's ok since we're using instance storage
options:
  use node's transform streams + crypto
    http://codewinds.com/blog/2013-08-20-nodejs-transform-streams.html
    http://nodejs.org/api/crypto.html
  dm-crypt

streaming replication instead of periodic snapshotting
  do normal replication using colab protocol instead of http
  instead of doing get_bufs, join workspace & apply patches
  allow multiplexing of workspaces over one connection

use symlink trick so that these are atomic
if workspace is active, NEVER update from another colab server

what to do when in the middle of fetching from another colab but someone connects?
  wait until done, then let them connect
  show them all old bufs
  show them currently-updated bufs. if they haven't changed the old bufs, update those once we get them

TODO
prune script (for deleting workspaces that were deleted when a server was down)
  (or master could just do this)
