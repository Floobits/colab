#!/bin/sh

if [ $# -ne 1 ]
then
  echo "Usage: $0 hostname"
  exit 0
fi

DATETIME=`date -u '+%Y_%m_%d_%H%M'`
RELEASE_NAME="colab-$DATETIME"

tar -c -z -f $RELEASE_NAME.tar.gz `git ls-files`

scp -C $RELEASE_NAME.tar.gz $1:/tmp

ssh $1 "sudo mkdir /data/releases/$RELEASE_NAME && sudo tar xzf /tmp/$RELEASE_NAME.tar.gz --directory /data/releases/$RELEASE_NAME"
ssh $1 "sudo cp /data/colab/lib/settings.js /data/releases/$RELEASE_NAME/lib/settings.js"
ssh $1 "sudo cp -r /data/colab/node_modules /data/releases/$RELEASE_NAME/"
ssh $1 "cd /data/releases/$RELEASE_NAME && \
sudo npm install && \
sudo ln -s -f /data/releases/$RELEASE_NAME /data/colab-new && \
sudo mv -T -f /data/colab-new /data/colab && \
sudo sv restart /service/colab/"
