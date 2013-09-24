3 types of servers
front-end
  apache
    http/https
    config files: apache config, ssl cert, django settings, etc
  cobalancer
    config files: list of control servers
    3418, 3448, socket io, socket io https
  memcached

control/db
  postgres
    config files: postgres config
  colabcontrol
    http/https
    polls colab servers (one day move to colabs pushing info)
    config files: list of colab servers

colab
  colab
    config files: settings.js
