#!/bin/sh

if [ $# -ne 1 ]
then
  echo "Usage: $0 hostname"
  exit 0
fi

rsync -avz --exclude=node_modules --exclude=lib/settings.js . $1:/data/colab

ssh $1 "cd /data/colab/ && npm install && sudo sv restart /service/colab/"
