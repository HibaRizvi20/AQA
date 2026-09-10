#!/usr/bin/env node
// A deliberately imperfect demo app, so the pipeline has something real to find.
// Three of its behaviours are wrong on purpose — see examples/demo-spec.json.
import http from "node:http";

const items = new Map();       // id -> url  (live)
const tombstoned = new Set();  // urls this user deleted — the source of the re-add bug
let seq = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const authed = req.headers.authorization === "Bearer demo-token";
  const readBody = () => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

  if (url.pathname === "/health") return send(200, { ok: true });
  if (url.pathname === "/login" && req.method === "POST") return send(200, { accessToken: "demo-token" });
  if (url.pathname === "/" || url.pathname === "/items-page") return send(200, { page: "ok" });

  if (url.pathname === "/v1/items" && req.method === "POST") {
    if (!authed) return send(401, { error: { code: "UNAUTHORIZED" } });
    return readBody().then((raw) => {
      let body;
      try { body = JSON.parse(raw || "{}"); } catch { return send(400, { error: { code: "BAD_REQUEST" } }); }
      let u = String(body.url ?? "").trim();
      if (!u) return send(400, { error: { code: "INVALID_URL", message: "url is required" } });
      if (u.length > 2048) return send(400, { error: { code: "INVALID_URL", message: "URL must be 2048 characters or fewer" } });

      // BUG 1: a scheme that is not http(s) is rewritten instead of rejected.
      if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      if (/^https?:\/\/(?!\w)/.test(u) || !/^https?:\/\/[\w.-]+/i.test(u)) {
        return send(400, { error: { code: "INVALID_URL", message: "That doesn't look like a valid link" } });
      }

      if ([...items.values()].includes(u)) return send(409, { error: { code: "ALREADY_SAVED" } });
      // BUG 2: re-adding something previously deleted collides instead of restoring.
      if (tombstoned.has(u)) return send(500, { error: { code: "SERVER_ERROR", message: "An error occurred" } });

      const id = `itm-${++seq}`;
      items.set(id, u);
      return send(201, { id, url: u, provider: "WEBSITE" });
    });
  }

  if (url.pathname === "/v1/items" && req.method === "GET") {
    if (!authed) return send(401, { error: { code: "UNAUTHORIZED" } });
    return send(200, { items: [...items].map(([id, u]) => ({ id, url: u })), hasMore: false });
  }

  if (url.pathname.startsWith("/v1/items/") && req.method === "DELETE") {
    if (!authed) return send(401, { error: { code: "UNAUTHORIZED" } });
    const id = url.pathname.split("/")[3];
    // BUG 3: a malformed id is a server error instead of a client error.
    if (!/^itm-\d+$/.test(id)) return send(500, { error: { code: "SERVER_ERROR", message: "An error occurred" } });
    if (!items.has(id)) return send(404, { error: { code: "NOT_FOUND" } });
    tombstoned.add(items.get(id));
    items.delete(id);
    return send(204);
  }

  send(404, { error: { code: "NOT_FOUND" } });
});

const port = Number(process.env.PORT ?? 4310);
server.listen(port, () => console.log(`demo app on http://127.0.0.1:${port}`));
