const http = require("node:http");
const https = require("node:https");
const { readFileSync } = require("node:fs");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");

const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const writeQueues = new Map();

function loadConfig(configPath = process.env.CONFIG_FILE || "./config.json") {
  const absolutePath = resolve(configPath);
  const config = JSON.parse(readFileSync(absolutePath, "utf8"));
  return { config, configPath: absolutePath, configDir: dirname(absolutePath) };
}

function validateResources(resources) {
  if (!Array.isArray(resources)) throw new Error("config.resources must be an array");
  for (const resource of resources) {
    if (typeof resource !== "string" || !/^[A-Za-z0-9_-]+$/.test(resource)) {
      throw new Error("Resource names may only contain letters, numbers, underscores, and hyphens");
    }
  }
}

function resolveDataDir(config, configDir) {
  return resolve(process.env.DATA_DIR || join(configDir, config.dataDir || "data"));
}

function resourceFile(dataDir, resource) {
  return join(dataDir, resource + ".json");
}

async function ensureResource(dataDir, resource) {
  await mkdir(dataDir, { recursive: true });
  const file = resourceFile(dataDir, resource);
  try {
    await readFile(file, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    try {
      await writeFile(file, "[]\n", { encoding: "utf8", flag: "wx" });
    } catch (writeError) {
      if (!writeError || writeError.code !== "EEXIST") throw writeError;
    }
  }
  return file;
}

async function readResource(dataDir, resource) {
  const file = await ensureResource(dataDir, resource);
  const value = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(value)) throw new Error("Resource data must be a JSON array");
  return value;
}

async function writeResource(dataDir, resource, value) {
  const file = await ensureResource(dataDir, resource);
  const temporaryFile = file + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(temporaryFile, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporaryFile, file);
}

function mutateResource(dataDir, resource, mutator) {
  const queueKey = resourceFile(dataDir, resource);
  const previous = writeQueues.get(queueKey) || Promise.resolve();
  const operation = previous.then(async () => {
    const items = await readResource(dataDir, resource);
    const result = await mutator(items);
    await writeResource(dataDir, resource, items);
    return result;
  });
  writeQueues.set(queueKey, operation.then(() => undefined, () => undefined));
  return operation;
}

function setCorsHeaders(response, config) {
  const cors = config.cors || {};
  const origin = cors.origin === undefined ? "*" : cors.origin;
  if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader(
    "Access-Control-Allow-Headers",
    cors.headers || "Origin, X-Requested-With, Content-Type, Accept"
  );
  response.setHeader(
    "Access-Control-Allow-Methods",
    cors.methods || "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function sendHtml(response, statusCode, value) {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(value);
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body || "{}");
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function looseMatch(actual, expected) {
  return actual != null && String(actual) === String(expected);
}

function idFieldFor(config, resource) {
  return config.resourceOptions &&
    config.resourceOptions[resource] &&
    config.resourceOptions[resource].idField
    ? config.resourceOptions[resource].idField
    : config.idField || "id";
}

function idValue(rawValue) {
  return /^-?\d+$/.test(rawValue) ? Number(rawValue) : rawValue;
}

function nextNumericId(items, idField) {
  return items.reduce((largest, item) => {
    const value = Number(item && item[idField]);
    return Number.isFinite(value) ? Math.max(largest, value) : largest;
  }, 0) + 1;
}

async function handleV2(request, response, url, context) {
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== "v2" || segments.length < 2 || segments.length > 3) return false;

  const resource = segments[1];
  if (!context.resources.has(resource)) {
    sendJson(response, 404, { error: "Resource not found" });
    return true;
  }

  const rawId = segments[2];
  const idField = idFieldFor(context.config, resource);
  const method = request.method || "GET";

  if (rawId === undefined && method === "GET") {
    let items = await readResource(context.dataDir, resource);
    const filters = [...url.searchParams.entries()];
    if (filters.length) {
      items = items.filter((item) =>
        filters.every(([key, value]) => looseMatch(item && item[key], value))
      );
    }
    sendJson(response, 200, items);
    return true;
  }

  if (rawId === undefined && method === "POST") {
    const input = await readJsonBody(request, context.maxBodyBytes);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      sendJson(response, 400, { error: "Resource item must be a JSON object" });
      return true;
    }
    const created = await mutateResource(context.dataDir, resource, (items) => {
      const item = { ...input };
      if (item[idField] === undefined || item[idField] === null || item[idField] === "") {
        item[idField] = nextNumericId(items, idField);
      } else if (items.some((current) => looseMatch(current && current[idField], item[idField]))) {
        const error = new Error("Resource item already exists");
        error.statusCode = 409;
        throw error;
      }
      items.push(item);
      return item;
    });
    sendJson(response, 201, created);
    return true;
  }

  if (rawId === undefined) {
    sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }

  if (method === "GET") {
    const items = await readResource(context.dataDir, resource);
    const item = items.find((current) => looseMatch(current && current[idField], rawId));
    sendJson(response, item ? 200 : 404, item || { error: "Resource item not found" });
    return true;
  }

  if (method === "PUT" || method === "PATCH") {
    const input = await readJsonBody(request, context.maxBodyBytes);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      sendJson(response, 400, { error: "Resource item must be a JSON object" });
      return true;
    }
    if (input[idField] !== undefined && !looseMatch(input[idField], rawId)) {
      sendJson(response, 400, { error: "Resource id does not match request path" });
      return true;
    }
    const updated = await mutateResource(context.dataDir, resource, (items) => {
      const index = items.findIndex((current) => looseMatch(current && current[idField], rawId));
      if (index < 0) return null;
      const existing = items[index];
      const item = method === "PATCH" ? { ...existing, ...input } : { ...input };
      item[idField] = existing[idField] === undefined ? idValue(rawId) : existing[idField];
      items[index] = item;
      return item;
    });
    sendJson(response, updated ? 200 : 404, updated || { error: "Resource item not found" });
    return true;
  }

  if (method === "DELETE") {
    const deleted = await mutateResource(context.dataDir, resource, (items) => {
      const index = items.findIndex((current) => looseMatch(current && current[idField], rawId));
      if (index < 0) return null;
      return items.splice(index, 1)[0];
    });
    sendJson(response, deleted ? 200 : 404, deleted || { error: "Resource item not found" });
    return true;
  }

  sendJson(response, 405, { error: "Method not allowed" });
  return true;
}

async function handleLegacy(request, response, url, context) {
  const resource = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!context.resources.has(resource)) {
    sendHtml(response, 404, "<h1>NOT FOUND...</h1>");
    return;
  }

  const method = request.method || "GET";
  const query = [...url.searchParams.entries()];

  if (method === "GET") {
    const items = await readResource(context.dataDir, resource);
    if (query.length === 0) {
      sendJson(response, 200, items);
    } else if (query.length === 1) {
      const [key, value] = query[0];
      sendJson(
        response,
        200,
        items.filter((item) => looseMatch(item && item[key], value))
      );
    } else {
      sendHtml(response, 404, "<h1>INVALID QUERY...</h1>");
    }
    return;
  }

  if (method === "POST") {
    const input = await readJsonBody(request, context.maxBodyBytes);
    if (query.length === 0) {
      await mutateResource(context.dataDir, resource, (items) => {
        items.push(input);
      });
      sendHtml(response, 200, "<h1>OK Registed<h1>");
    } else if (query.length === 1) {
      const [key, value] = query[0];
      await mutateResource(context.dataDir, resource, (items) => {
        for (let index = 0; index < items.length; index += 1) {
          if (looseMatch(items[index] && items[index][key], value)) items[index] = input;
        }
      });
      sendHtml(response, 200, "<h1>OK Updated<h1>");
    } else {
      sendHtml(response, 404, "<h1>INVALID QUERY...</h1>");
    }
    return;
  }

  if (method === "DELETE") {
    if (query.length !== 1) {
      sendHtml(response, 404, "<h1>INVALID QUERY...</h1>");
      return;
    }
    const [key, value] = query[0];
    await mutateResource(context.dataDir, resource, (items) => {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (looseMatch(items[index] && items[index][key], value)) items.splice(index, 1);
      }
    });
    sendHtml(response, 200, "<h1>OK Deleted<h1>");
    return;
  }

  sendHtml(response, 405, "<h1>METHOD NOT ALLOWED...</h1>");
}

async function serveIndex(response, configDir) {
  try {
    const body = await readFile(join(configDir, "static", "index.html"), "utf8");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
  } catch {
    sendHtml(response, 404, "<h1>NOT FOUND...</h1>");
  }
}

function createHandler(context) {
  return async function handler(request, response) {
    setCorsHeaders(response, context.config);
    if (request.method === "OPTIONS") {
      response.writeHead(200);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", version: 2 });
      return;
    }
    if (url.pathname === "/") {
      await serveIndex(response, context.configDir);
      return;
    }
    if (await handleV2(request, response, url, context)) return;
    await handleLegacy(request, response, url, context);
  };
}

function readCertificateFile(configDir, path, name) {
  if (!path || typeof path !== "string") throw new Error("https." + name + " is required");
  return readFileSync(resolve(configDir, path));
}

function createProtocolServer(config, configDir, handler) {
  if (!config.https || config.https.enabled !== true) return { server: http.createServer(handler), scheme: "http" };

  const options = {
    key: readCertificateFile(configDir, config.https.keyFile, "keyFile"),
    cert: readCertificateFile(configDir, config.https.certFile, "certFile"),
  };
  if (config.https.caFile) options.ca = readCertificateFile(configDir, config.https.caFile, "caFile");
  if (config.https.passphrase !== undefined) options.passphrase = String(config.https.passphrase);
  return { server: https.createServer(options, handler), scheme: "https" };
}

async function startServer(options = {}) {
  const loaded = loadConfig(options.configPath);
  const { config, configDir } = loaded;
  validateResources(config.resources);
  const dataDir = options.dataDir || resolveDataDir(config, configDir);
  const resources = new Set(config.resources);

  for (const resource of resources) await ensureResource(dataDir, resource);

  const context = {
    config,
    configDir,
    dataDir,
    resources,
    maxBodyBytes: Number(config.maxBodyBytes || DEFAULT_MAX_BODY_BYTES),
  };
  const handler = createHandler(context);
  const protocol = createProtocolServer(config, configDir, (request, response) => {
    handler(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const isV2 = (request.url || "").startsWith("/v2/");
      const statusCode = Number(error && error.statusCode) || 500;
      if (isV2) sendJson(response, statusCode, { error: error instanceof Error ? error.message : "Internal server error" });
      else sendHtml(response, statusCode, "err has occured.");
    });
  });

  const port = Number(process.env.PORT !== undefined ? process.env.PORT : (config.port ?? 3000));
  const host = process.env.HOST || config.host || "0.0.0.0";
  await new Promise((resolveListen, reject) => {
    protocol.server.once("error", reject);
    protocol.server.listen(port, host, resolveListen);
  });
  const address = protocol.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log("The server has started: " + protocol.scheme + "://" + host + ":" + actualPort);
  return { ...protocol, port: actualPort, host, config, dataDir };
}

if (require.main === module) {
  startServer().then(({ server }) => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => server.close(() => process.exit(0)));
    }
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  createHandler,
  createProtocolServer,
  loadConfig,
  startServer,
};
