FROM floobits-base

ADD colab-current.tar.gz /data/colab
WORKDIR /data/colab
RUN npm install

RUN ln -s /data/conf/settings-colab.js /data/colab/lib/settings.js

ENTRYPOINT ["/data/colab/bin/colab"]

EXPOSE 80
EXPOSE 443
EXPOSE 3148
EXPOSE 3448
EXPOSE 8048
EXPOSE 8443
