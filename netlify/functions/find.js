// Lets Netlify run the same video finder as api/find.js.
const find = require("../../api/find.js");

exports.handler = event => new Promise(resolve => {
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(k, v) { headers[k] = v; },
    end(body) { resolve({ statusCode: this.statusCode, headers, body }); }
  };
  find({ query: event.queryStringParameters || {} }, res);
});
