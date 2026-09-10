// Live probing — routes, authentication, and API contracts.
//
// This is the module that closes the gap the first real run exposed: the pipeline could reason
// about UI selectors but never touched the API, so contract-level defects (a re-add returning
// 500, a malformed id returning 500, a scheme being rewritten instead of rejected) were invisible
// to it. A contract probe executes the request for real and compares the response to what the
// spec declared, which is the only way those are ever found.
//
// Rules this module holds to:
//   · A probe that could not run is reported as `skipped` WITH its reason. It is never a pass.
//   · A network failure is a result, not an exception — one unreachable endpoint must not abort
//     the pipeline and lose the other twenty results.
//   · Every request is bounded by a timeout, so a hung server cannot hang the run.

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic

/** fetch with a hard timeout, never throwing — the failure comes back as a value. */
export async function request(url, { timeoutMs = 10000, ...init } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = now();
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON — keep the text, some endpoints answer 204 or HTML */
    }
    return {
      ok: true,
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: json,
      text,
      durationMs: +(now() - started).toFixed(1),
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      error: e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(e.cause?.code ?? e.message),
      durationMs: +(now() - started).toFixed(1),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Substitute {placeholders} through any string in a value, however deeply nested.
 *
 * This is what lets a spec be re-run against a stateful app without manual cleanup: a URL
 * written as "https://example.com/item-{run}" is unique per run, so the second run is not
 * poisoned by data the first one left behind. A suite that only passes on a clean database is
 * a suite nobody can trust on a shared environment.
 */
export function substituteDeep(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteDeep(v, vars)]));
  }
  return value;
}

/** Read a dotted path out of a response body: "user.id", "resources.0.id". */
export function readPath(obj, dotted) {
  return String(dotted)
    .split(".")
    .reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/** Check every declared UI route is reachable. Reachability only — not a rendering check. */
export async function probeRoutes(baseUrl, routes = [], { timeoutMs } = {}) {
  const results = [];
  for (const route of routes) {
    const r = await request(new URL(route, baseUrl).toString(), { timeoutMs, redirect: "manual" });
    results.push({
      route,
      status: r.ok ? (r.status < 400 ? "reachable" : "error") : "unreachable",
      evidence: r.ok ? `HTTP ${r.status}` : r.error,
      httpStatus: r.status,
      durationMs: r.durationMs,
    });
  }
  return results;
}

/**
 * Obtain a bearer token. Returns { token, ...detail } or { token: null, reason } — never throws,
 * so a pipeline can continue and report auth-dependent probes as skipped.
 */
export async function authenticate(cfg, auth, { timeoutMs } = {}) {
  if (!auth) return { token: null, reason: "the spec declares no auth block" };
  if (!cfg.canAuthenticate) return { token: null, reason: "TEST_USERNAME / TEST_PASSWORD are not set" };

  const body = JSON.stringify(
    auth.body ?? { email: cfg.TEST_USERNAME, password: cfg.TEST_PASSWORD },
  );
  const r = await request(new URL(auth.path, cfg.API_BASE_URL).toString(), {
    method: auth.method ?? "POST",
    headers: { "Content-Type": "application/json" },
    body,
    timeoutMs,
  });
  if (!r.ok) return { token: null, reason: `auth request failed: ${r.error}` };
  if (r.status >= 400) return { token: null, reason: `auth returned HTTP ${r.status}` };

  const token = readPath(r.body, auth.tokenField);
  if (!token) return { token: null, reason: `no "${auth.tokenField}" in the auth response` };
  return { token, status: r.status, durationMs: r.durationMs };
}

/**
 * Execute one declared contract and compare the response with what the spec said it should be.
 *
 * Returns { verdict: "pass" | "fail" | "skipped", checks: [...], evidence }.
 * `checks` lists each assertion separately so a failure names exactly what differed.
 */
export async function probeContract(contract, { apiBase, token, timeoutMs, substitute = {} } = {}) {
  if (!contract) return { verdict: "skipped", reason: "no contract declared for this behaviour", checks: [] };

  const needsAuth = contract.auth !== false;
  if (needsAuth && !token) {
    return { verdict: "skipped", reason: "this contract needs authentication and no token was obtained", checks: [] };
  }

  // Splice in a previous step's captured value ("/v1/resources/{id}") and any run-scoped
  // variable ("{run}"), through the path AND the body.
  const path = substituteDeep(String(contract.path), substitute);
  const body = contract.body === undefined ? undefined : substituteDeep(contract.body, substitute);
  if (/\{\w+\}/.test(path)) {
    return { verdict: "skipped", reason: `path still contains an unresolved placeholder: ${path}`, checks: [] };
  }

  const headers = { ...(contract.headers ?? {}) };
  if (body !== undefined) headers["Content-Type"] ??= "application/json";
  if (needsAuth && token) headers.Authorization = `Bearer ${token}`;

  const res = await request(new URL(path, apiBase).toString(), {
    method: contract.method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  });

  if (!res.ok) {
    return {
      verdict: "fail",
      reason: `request failed: ${res.error}`,
      checks: [{ check: "request completes", expected: "a response", actual: res.error, ok: false }],
      request: { method: contract.method, path },
    };
  }

  const checks = [];
  const want = contract.expect;
  const wantStatus = Array.isArray(want.status) ? want.status : [want.status];
  checks.push({
    check: "status",
    expected: wantStatus.join(" or "),
    actual: String(res.status),
    ok: wantStatus.includes(res.status),
  });

  for (const field of want.hasFields ?? []) {
    const v = readPath(res.body, field);
    checks.push({
      check: `field "${field}" is present`,
      expected: "present",
      actual: v === undefined ? "absent" : typeof v,
      ok: v !== undefined,
    });
  }

  for (const [field, expected] of Object.entries(want.bodyMatches ?? {})) {
    const actual = readPath(res.body, field);
    checks.push({
      check: `field "${field}" equals`,
      expected: JSON.stringify(expected),
      actual: JSON.stringify(actual),
      ok: JSON.stringify(actual) === JSON.stringify(expected),
    });
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    verdict: failed.length === 0 ? "pass" : "fail",
    checks,
    failed: failed.map((c) => `${c.check}: expected ${c.expected}, got ${c.actual}`),
    request: { method: contract.method, path },
    response: { status: res.status, durationMs: res.durationMs, body: res.body },
    capture: contract.capture ? { [contract.capture]: readPath(res.body, contract.capture) } : null,
  };
}

/**
 * Run a behaviour's contract, plus any setup contracts it declares, threading captured values
 * (an id created in setup can be spliced into the path under test).
 */
export async function probeBehaviour(behaviour, ctx) {
  const substitute = { ...(ctx.substitute ?? {}) };
  const setup = [];

  for (const s of behaviour.contract?.setup ?? []) {
    const r = await probeContract(s, { ...ctx, substitute });
    setup.push({ step: `${s.method} ${s.path}`, verdict: r.verdict, ...(r.failed ? { failed: r.failed } : {}) });
    if (r.capture) Object.assign(substitute, r.capture);
    if (r.verdict === "fail") {
      return {
        verdict: "skipped",
        reason: `setup step ${s.method} ${s.path} failed, so the behaviour was never exercised`,
        setup,
        checks: [],
      };
    }
  }

  const main = await probeContract(behaviour.contract, { ...ctx, substitute });
  return { ...main, ...(setup.length ? { setup } : {}) };
}
