import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { request, readPath, probeRoutes, authenticate, probeContract, probeBehaviour } from "./probe.mjs";

// A real server rather than a stubbed fetch: these functions exist to talk to a live app, and a
// test that mocks the transport would prove nothing about whether they can.
let server, base;
const created = new Map();

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const auth = req.headers.authorization === "Bearer good-token";

    if (url.pathname === "/login" && req.method === "POST") return send(200, { accessToken: "good-token" });
    if (url.pathname === "/login-no-token" && req.method === "POST") return send(200, { nope: 1 });
    if (url.pathname === "/slow") return setTimeout(() => send(200, { ok: true }), 400);
    if (url.pathname === "/html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<h1>hi</h1>"); }
    if (url.pathname === "/library") return send(200, { ok: true });
    if (url.pathname === "/missing") return send(404, { error: "nope" });

    if (url.pathname === "/items" && req.method === "POST") {
      if (!auth) return send(401, { error: { code: "UNAUTHORIZED" } });
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        const { url: u } = JSON.parse(body || "{}");
        if (!u) return send(400, { error: { code: "INVALID_URL" } });
        const id = "id-" + (created.size + 1);
        created.set(id, u);
        send(201, { id, url: u, provider: "WEBSITE" });
      });
    }
    if (url.pathname.startsWith("/items/") && req.method === "DELETE") {
      if (!auth) return send(401, { error: { code: "UNAUTHORIZED" } });
      const id = url.pathname.split("/")[2];
      if (!created.has(id)) return send(404, { error: { code: "NOT_FOUND" } });
      created.delete(id);
      return send(204);
    }
    send(404, { error: "unknown" });
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

describe("request", () => {
  test("returns a value on success, never throws", async () => {
    const r = await request(`${base}/library`);
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.ok(r.durationMs >= 0);
  });

  test("a connection failure is a result, not an exception", async () => {
    const r = await request("http://127.0.0.1:1/nope", { timeoutMs: 500 });
    assert.equal(r.ok, false);
    assert.equal(r.status, null);
    assert.ok(r.error, "an error string is required so the report can say why");
  });

  test("a hung endpoint is bounded by the timeout", async () => {
    const r = await request(`${base}/slow`, { timeoutMs: 80 });
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
  });

  test("a non-JSON body does not break the parse", async () => {
    const r = await request(`${base}/html`);
    assert.equal(r.ok, true);
    assert.equal(r.body, null);
    assert.match(r.text, /<h1>/);
  });
});

describe("readPath", () => {
  test("reads nested and indexed paths", () => {
    const o = { user: { id: 7 }, list: [{ id: "a" }] };
    assert.equal(readPath(o, "user.id"), 7);
    assert.equal(readPath(o, "list.0.id"), "a");
  });
  test("returns undefined rather than throwing on a missing path", () => {
    assert.equal(readPath({}, "a.b.c"), undefined);
    assert.equal(readPath(null, "a"), undefined);
  });
});

describe("probeRoutes", () => {
  test("classifies reachable, error and unreachable separately", async () => {
    const rs = await probeRoutes(base, ["/library", "/missing"], { timeoutMs: 1000 });
    assert.equal(rs[0].status, "reachable");
    assert.equal(rs[1].status, "error");
    const dead = await probeRoutes("http://127.0.0.1:1", ["/x"], { timeoutMs: 300 });
    assert.equal(dead[0].status, "unreachable");
    assert.ok(dead[0].evidence);
  });
});

describe("authenticate", () => {
  const cfg = (o = {}) => ({ API_BASE_URL: base, canAuthenticate: true, TEST_USERNAME: "u", TEST_PASSWORD: "p", ...o });

  test("returns a token", async () => {
    const r = await authenticate(cfg(), { path: "/login", tokenField: "accessToken" });
    assert.equal(r.token, "good-token");
  });

  test("no credentials is a reason, not a crash", async () => {
    const r = await authenticate(cfg({ canAuthenticate: false }), { path: "/login", tokenField: "accessToken" });
    assert.equal(r.token, null);
    assert.match(r.reason, /TEST_USERNAME/);
  });

  test("a response without the token field says so", async () => {
    const r = await authenticate(cfg(), { path: "/login-no-token", tokenField: "accessToken" });
    assert.equal(r.token, null);
    assert.match(r.reason, /accessToken/);
  });
});

describe("probeContract", () => {
  const ctx = () => ({ apiBase: base, token: "good-token", timeoutMs: 2000 });

  test("passes when status and fields match", async () => {
    const r = await probeContract(
      { method: "POST", path: "/items", body: { url: "https://e.com/1" }, expect: { status: 201, hasFields: ["id", "provider"] } },
      ctx(),
    );
    assert.equal(r.verdict, "pass");
    assert.ok(r.checks.every((c) => c.ok));
  });

  test("fails on the wrong status and names what differed", async () => {
    const r = await probeContract({ method: "POST", path: "/items", body: {}, expect: { status: 201 } }, ctx());
    assert.equal(r.verdict, "fail");
    assert.match(r.failed[0], /status: expected 201, got 400/);
  });

  test("fails on a missing field", async () => {
    const r = await probeContract(
      { method: "POST", path: "/items", body: { url: "https://e.com/2" }, expect: { status: 201, hasFields: ["nope"] } },
      ctx(),
    );
    assert.equal(r.verdict, "fail");
    assert.match(r.failed[0], /"nope"/);
  });

  test("checks a body value", async () => {
    const r = await probeContract(
      { method: "POST", path: "/items", body: { url: "https://e.com/3" }, expect: { status: 201, bodyMatches: { provider: "WEBSITE" } } },
      ctx(),
    );
    assert.equal(r.verdict, "pass");
  });

  test("an accepted list of statuses passes on any of them", async () => {
    const r = await probeContract({ method: "GET", path: "/missing", auth: false, expect: { status: [200, 404] } }, ctx());
    assert.equal(r.verdict, "pass");
  });

  test("no token means SKIPPED with a reason — never a pass", async () => {
    const r = await probeContract({ method: "POST", path: "/items", expect: { status: 201 } }, { ...ctx(), token: null });
    assert.equal(r.verdict, "skipped");
    assert.match(r.reason, /authentication/);
  });

  test("an unresolved placeholder is skipped, not requested", async () => {
    const r = await probeContract({ method: "DELETE", path: "/items/{id}", expect: { status: 204 } }, ctx());
    assert.equal(r.verdict, "skipped");
    assert.match(r.reason, /placeholder/);
  });

  test("an unreachable API is a fail with evidence, not a thrown error", async () => {
    const r = await probeContract(
      { method: "GET", path: "/x", auth: false, expect: { status: 200 } },
      { apiBase: "http://127.0.0.1:1", token: null, timeoutMs: 300 },
    );
    assert.equal(r.verdict, "fail");
    assert.match(r.reason, /request failed/);
  });
});

describe("probeBehaviour · setup chaining", () => {
  test("captures an id in setup and splices it into the path under test", async () => {
    const b = {
      id: "T-1",
      contract: {
        method: "DELETE",
        path: "/items/{id}",
        expect: { status: 204 },
        setup: [
          { method: "POST", path: "/items", body: { url: "https://e.com/chain" }, expect: { status: 201 }, capture: "id" },
        ],
      },
    };
    const r = await probeBehaviour(b, { apiBase: base, token: "good-token", timeoutMs: 2000 });
    assert.equal(r.verdict, "pass");
    assert.equal(r.setup[0].verdict, "pass");
  });

  test("a failed setup skips the behaviour rather than reporting a false failure", async () => {
    const b = {
      id: "T-2",
      contract: {
        method: "DELETE",
        path: "/items/{id}",
        expect: { status: 204 },
        setup: [{ method: "POST", path: "/items", body: {}, expect: { status: 201 }, capture: "id" }],
      },
    };
    const r = await probeBehaviour(b, { apiBase: base, token: "good-token", timeoutMs: 2000 });
    assert.equal(r.verdict, "skipped");
    assert.match(r.reason, /setup step/);
  });
});
