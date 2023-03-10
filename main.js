// Require
const http = require("http");
const url = require("url");
const fs = require("fs");
const init = require("./lib/init.js");

// Load Config
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

// Server const
const server = http.createServer();
const dataDir = "./data";

// Initial
init(dataDir, config.resources);

server.on("request", function (req, res) {
  const urlParse = url.parse(req.url, true);
  if (urlParse.pathname === "/") {
    fs.readFile(__dirname + "/static/index.html", "utf8", function (err, data) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write(data);
      res.end();
    });
  } else if (config.resources.includes(urlParse.replace("/", ""))) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.write("ok");
    res.end();
  } else {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.write("<h1>NOT FOUND...</h1>");
    res.end();
  }
});

server.listen(config.port);
console.log(
  `The server has started and is listening on port number: ${config.port}`
);
