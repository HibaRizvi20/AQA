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
  // A real page, so UI behaviours have something to drive. Deliberately carries the same
  // ambiguity a real app grows: two buttons rendering the same glyph, only `title` apart.
  if (url.pathname === "/" || url.pathname === "/items-page") {
    const rows = [...items].map(([id, u]) =>
      `<li data-testid="item" data-id="${id}"><span>${u}</span>` +
      `<button title="Delete" data-testid="item-delete" data-id="${id}">✕</button></li>`).join("");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Demo</title>
<h1>Saved items</h1>
<p data-testid="count">${items.size} item${items.size === 1 ? "" : "s"}</p>
<button title="Dismiss" data-testid="banner-dismiss">✕</button>
<input data-testid="link" placeholder="Paste a link">
<button data-testid="save">Save</button>
<ul data-testid="items">${rows}</ul>
<script>
const $ = (s) => document.querySelector(s);
$('[data-testid=save]').onclick = async () => {
  await fetch('/v1/items', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer demo-token' },
    body: JSON.stringify({ url: $('[data-testid=link]').value }) });
  location.reload();
};
document.querySelectorAll('[data-testid=item-delete]').forEach((b) => {
  b.onclick = async () => {
    if (!confirm('Delete this item?')) return;
    await fetch('/v1/items/' + b.dataset.id, { method: 'DELETE', headers: { Authorization: 'Bearer demo-token' } });
    location.reload();
  };
});
$('[data-testid=banner-dismiss]').onclick = () => $('[data-testid=banner-dismiss]').remove();
</script>`);
  }

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
