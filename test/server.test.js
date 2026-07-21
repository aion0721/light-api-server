const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { startServer } = require("../main");

async function createServerConfig(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "light-api-server-"));
  const configPath = join(directory, "config.json");
  const config = {
    port: 0,
    host: "127.0.0.1",
    resources: ["fruit"],
    ...overrides,
  };
  await writeFile(configPath, JSON.stringify(config), "utf8");
  return { configPath, dataDir: join(directory, "data") };
}

function request(server, method, path, body) {
  const transport = server.scheme === "https" ? https : http;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolveRequest, reject) => {
    const req = transport.request(
      {
        hostname: server.host,
        port: server.port,
        path,
        method,
        rejectUnauthorized: false,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : undefined,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolveRequest({ status: response.statusCode, headers: response.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(config, callback) {
  const paths = await createServerConfig(config);
  const server = await startServer(paths);
  try {
    await callback(server);
  } finally {
    await new Promise((resolveClose, reject) =>
      server.server.close((error) => error ? reject(error) : resolveClose())
    );
  }
}

test("legacy API remains compatible", async () => {
  await withServer({}, async (server) => {
    let result = await request(server, "POST", "/fruit", { id: 1, name: "apple" });
    assert.equal(result.status, 200);
    assert.match(result.text, /OK Registed/);

    result = await request(server, "GET", "/fruit?id=1");
    assert.deepEqual(result.json, [{ id: 1, name: "apple" }]);

    result = await request(server, "POST", "/fruit?id=1", { id: 1, name: "green apple" });
    assert.equal(result.status, 200);
    assert.match(result.text, /OK Updated/);
    assert.deepEqual((await request(server, "GET", "/fruit")).json, [{ id: 1, name: "green apple" }]);

    result = await request(server, "DELETE", "/fruit?id=1");
    assert.equal(result.status, 200);
    assert.match(result.text, /OK Deleted/);
    assert.deepEqual((await request(server, "GET", "/fruit")).json, []);
  });
});

test("v2 generic REST API supports CRUD, filters, and errors", async () => {
  await withServer({}, async (server) => {
    const first = await request(server, "POST", "/v2/fruit", { name: "apple", color: "red" });
    assert.equal(first.status, 201);
    assert.deepEqual(first.json, { id: 1, name: "apple", color: "red" });

    const second = await request(server, "POST", "/v2/fruit", { name: "banana", color: "yellow" });
    assert.equal(second.json.id, 2);
    assert.equal((await request(server, "POST", "/v2/fruit", { id: 2 })).status, 409);

    assert.deepEqual((await request(server, "GET", "/v2/fruit?color=yellow")).json, [second.json]);
    assert.deepEqual((await request(server, "GET", "/v2/fruit/1")).json, first.json);

    const patched = await request(server, "PATCH", "/v2/fruit/1", { color: "green" });
    assert.deepEqual(patched.json, { id: 1, name: "apple", color: "green" });
    assert.equal((await request(server, "PUT", "/v2/fruit/1", { id: 99 })).status, 400);

    const replaced = await request(server, "PUT", "/v2/fruit/1", { name: "pear" });
    assert.deepEqual(replaced.json, { id: 1, name: "pear" });
    assert.equal((await request(server, "DELETE", "/v2/fruit/1")).status, 200);
    assert.equal((await request(server, "GET", "/v2/fruit/1")).status, 404);
    assert.deepEqual((await request(server, "GET", "/health")).json, { status: "ok", version: 2 });
  });
});

test("concurrent v2 creates receive unique ids and persist every item", async () => {
  await withServer({}, async (server) => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => request(server, "POST", "/v2/fruit", { name: `item-${index}` }))
    );
    assert.ok(results.every((result) => result.status === 201));
    assert.equal(new Set(results.map((result) => result.json.id)).size, 20);
    assert.equal((await request(server, "GET", "/v2/fruit")).json.length, 20);
  });
});

test("HTTPS starts from configured certificate files", async () => {
  const fixtureDir = resolve(__dirname, "fixtures");
  await withServer(
    {
      https: {
        enabled: true,
        keyFile: join(fixtureDir, "server.key"),
        certFile: join(fixtureDir, "server.crt"),
      },
    },
    async (server) => {
      assert.equal(server.scheme, "https");
      const result = await request(server, "GET", "/health");
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { status: "ok", version: 2 });
    }
  );
});

test("body size limit is enforced", async () => {
  await withServer({ maxBodyBytes: 16 }, async (server) => {
    const result = await request(server, "POST", "/v2/fruit", { name: "too-long-for-limit" });
    assert.equal(result.status, 413);
    assert.deepEqual(result.json, { error: "Request body is too large" });
  });
});
