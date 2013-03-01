var _ = require('underscore');
var knox = require('knox');

var settings = require('./settings');


var s3_client;

function get_s3_client() {
    if (_.isUndefined(s3_client)) {
        s3_client = knox.createClient(settings.s3);
    }
    return s3_client;
}

module.exports = {
    get_s3_client: get_s3_client;
};
