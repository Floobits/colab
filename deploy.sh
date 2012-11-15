#!/bin/sh

if [ $# -ne 1 ]
then
  echo "Usage: $0 hostname"
  exit 0
fi

rsync -avz --exclude=node_modules . $1:/data/colab

ssh $1 "cd /data/colab/ && npm install"
ssh $1 "sudo sv restart /service/colab/"
