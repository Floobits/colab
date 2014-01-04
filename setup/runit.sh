#!/bin/bash

cp -r runit /etc/sv/colab

if [ ! -e /etc/service/colab ]
then
    echo "/etc/service/colab doesn't exist. Creating it..."
    ln -s /etc/sv/colab /etc/service/
fi

if [ ! -e /service ]
then
    echo "/service doesn't exist. Creating it..."
    ln -s /etc/service /service
fi

if [ ! -e /service/colab/log/main ]
then
    echo "/service/colab/log/main doesn't exist. Creating it..."
	mkdir -p /service/colab/log/main && sudo chown nobody: /service/colab/log/main
fi
