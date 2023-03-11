// Require
const fs = require("fs");

// Main function
function init(dataDir, resouces) {
  dirCheck(dataDir);
  fileCheck(dataDir, resouces);
}

// Check data directory
const dirCheck = (dataDir) => {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, (err) => {
      throw err;
    });
    console.log("=== Initial === Create data directory.");
  }
};

const fileCheck = (dataDir, resources) => {
  // Check resources files
  for (const resource of resources) {
    const resourceFilePath = `${dataDir}/${resource}.json`;
    if (!fs.existsSync(resourceFilePath)) {
      fs.writeFileSync(resourceFilePath, "[]", (err) => {
        throw err;
      });
      console.log(`=== Initial === Create resouce file(resouce: ${resource})`);
    }
  }
};

module.exports = init;
