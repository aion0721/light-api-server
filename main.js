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
  // const
  const urlParse = url.parse(req.url, true);
  const reqResource = urlParse.pathname.replace("/", "");
  const reqMethod = req.method;
  const reqQuery = urlParse.query;
  const reqQueryLength = Object.keys(reqQuery).length;

  // Static Index
  if (urlParse.pathname === "/") {
    fs.readFile(__dirname + "/static/index.html", "utf8", function (err, data) {
      try {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.write(data);
        res.end();
      } catch {
        throw err;
      }
    });
    // Check Exist Resource
  } else if (config.resources.includes(reqResource)) {
    // GET
    if (reqMethod == "GET") {
      fs.readFile(
        __dirname + "/" + dataDir + "/" + reqResource,
        "utf8",
        function (err, data) {
          try {
            // Check query
            if (reqQueryLength === 0) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.write(data);
              res.end();
            } else if (reqQueryLength === 1) {
              const searchData = JSON.parse(data).filter((item, index) => {
                if (item.id == reqQuery.id) return true;
              });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.write(JSON.stringify(searchData));
              res.end();
            } else {
              res.writeHead(404, { "Content-Type": "text/html" });
              res.write("<h1>INVALID QUERY...</h1>");
              res.end();
            }
          } catch {
            res.writeHead(500, { "Content-Type": "text/html" });
            res.write("err has occured.");
            res.end();
            throw err;
          }
        }
      );

      return;
    }
    // POST
    if (reqMethod == "POST") {
    }

    // DELETE
    if (reqMethod == "DELETE") {
    }
    // Not found Resources
  } else {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.write("<h1>NOT FOUND...</h1>");
    res.end();
  }
});

// Server start
server.listen(config.port);
console.log(
  `The server has started and is listening on port number: ${config.port}`
);
