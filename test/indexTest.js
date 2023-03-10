//Require
const assert = require("assert");
const http = require("http");
const fs = require("fs");

// Load Config
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

if (require.main === module) {
  main();
}

async function main() {
  try {
    // test List
    const tests = [indexTest];

    // Test
    for (const test of tests) {
      try {
        await test();
        console.log(`OK ${test.name}`);
      } catch (err) {
        console.log(`NG ${test.name}`);
        console.error(err);
      }
    }
  } catch (err) {
    console.error(err);
  }
}

// Test Function
async function indexTest() {
  http.get(`http://localhost:${config.port}/`, (res) => {
    assert.equal(res.statusCode, 200);
  });
}
