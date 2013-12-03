#!/bin/sh

if [ $# -eq 0 ]
then
  echo "Usage: $0 release-name.tar.gz hostname0 hostname1 hostname2 ..."
  exit 0
fi

echo $1 | grep '\.tar\.gz$'

if [ $? -eq 0 ]
then
  TARBALL=$1
  shift
else
  echo "Building tarball..."
  TARBALL=`./build_release.sh`
  echo "Built $TARBALL"
fi

RELEASE_NAME=$(basename "$TARBALL")
RELEASE_NAME="${RELEASE_NAME%%.*}"
RELEASE_DIR="/data/releases/$RELEASE_NAME"

for HOST in $@
do
  echo "Deploying $RELEASE_NAME to $HOST"

  scp -C $RELEASE_NAME.tar.gz $HOST:/tmp

  ssh $HOST "sudo mkdir /data/releases/$RELEASE_NAME && sudo tar xzf /tmp/$RELEASE_NAME.tar.gz --directory /data/releases/$RELEASE_NAME"
  ssh $HOST "sudo cp /data/colab/lib/settings.js /data/releases/$RELEASE_NAME/lib/settings.js"
  ssh $HOST "sudo cp -r /data/colab/node_modules /data/releases/$RELEASE_NAME/"
  ssh $HOST "cd /data/releases/$RELEASE_NAME && \
  sudo npm install && \
  sudo npm update && \
  sudo ln -s -f /data/releases/$RELEASE_NAME /data/colab-new && \
  sudo mv -T -f /data/colab-new /data/colab && \
  sudo sv restart /service/colab/"

done
