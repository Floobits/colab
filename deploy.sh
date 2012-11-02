#!/bin/sh

DATA_DIR=/data
#DATA_DIR=/data-staging

rsync -avz . floobits.com:$DATA_DIR/colab
ssh floobits.com "sudo sv restart /service/colab/"
