// Require
const http = require("http");
const fs = require("fs");
const server = http.createServer();

// Load Config
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

server.on("request", function (req, res) {
  switch (req.url) {
    case "/":
      fs.readFile(
        __dirname + "/static/index.html",
        "utf8",
        function (err, data) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.write(data);
          res.end();
        }
      );
      break;
    default:
      res.writeHead(404, { "Content-Type": "text/html" });
      res.write("<h1>NOT FOUND...</h1>");
      res.end();
  }
});

server.listen(config.port);
console.log(
  `The server has started and is listening on port number: ${config.port}`
);
