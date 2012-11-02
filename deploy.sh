#!/bin/sh

DATA_DIR=/data
#DATA_DIR=/data-staging

rsync -avz --exclude=node_modules . floobits.com:$DATA_DIR/colab

ssh floobits.com "cd $DATA_DIR/colab/ && npm install"

ssh floobits.com "sudo sv restart /service/colab/"
