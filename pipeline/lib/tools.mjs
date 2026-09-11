// The toolbelt.
//
// This is where the deterministic work belongs: not as a replacement for the
// agents, but as the things they reach for. An agent decides WHAT to check; a
// tool performs the check honestly and reports exactly what happened.
//
// That division is the whole point. Judgement is the agent's — what is worth
// testing, which objective this behaviour becomes, whether a failure is the
// test's fault or the product's. Execution is the tool's, and a tool never
// softens a result to make an agent's story work.
//
// Tools are granted per phase. An agent can only do what it was handed, which
// is how "the Reviewer cannot fix its own findings" stops being a sentence in a
// prompt and becomes a fact about what it can reach.

import fs from "node:fs";
import path from "node:path";
import {probeRoutes, probeContract, probeBehaviour, request} from "./probe.mjs";
import {loadDriver, runUiBehaviour} from "./ui.mjs";
import {applyTags, validateTags, explainType} from "./tags.mjs";

const clamp = (v, n = 40_000) => {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > n ? s.slice(0, n) + `\n… truncated at ${n} characters` : s;
};

/* ── probing the running app ─────────────────────────────────────────────── */

export function probeTools(ctx) {
  return [
    {
      name: "probe_routes",
      description:
        "Check that UI routes on the app under test are reachable. Use this to find out what the app actually exposes instead of assuming. Returns a status per route with the evidence.",
      input_schema: {
        type: "object",
        properties: {routes: {type: "array", items: {type: "string"}, description: 'e.g. ["/library", "/login"]'}},
        required: ["routes"],
      },
      run: ({routes}) => probeRoutes(ctx.cfg.APP_BASE_URL, routes, {timeoutMs: ctx.cfg.REQUEST_TIMEOUT_MS}),
    },
    {
      name: "probe_api",
      description:
        "Send one request to the API under test and compare the response with what you expected. This is how a contract-level defect is found: state the expected status and fields, and the tool reports exactly what differed. It never softens a result.",
      input_schema: {
        type: "object",
        properties: {
          method: {type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]},
          path: {type: "string", description: 'path only, e.g. "/v1/items"'},
          body: {type: "object", description: "JSON request body, if any"},
          auth: {type: "boolean", description: "send the bearer token (default true)"},
          expect: {
            type: "object",
            properties: {
              status: {description: "an HTTP status, or an array of acceptable ones"},
              hasFields: {type: "array", items: {type: "string"}, description: 'dotted paths, e.g. ["id","user.name"]'},
              bodyMatches: {type: "object", description: "field path to expected value"},
            },
            required: ["status"],
          },
        },
        required: ["method", "path", "expect"],
      },
      run: (args) =>
        probeContract(args, {
          apiBase: ctx.cfg.API_BASE_URL,
          token: ctx.session?.token ?? null,
          timeoutMs: ctx.cfg.REQUEST_TIMEOUT_MS,
          substitute: {run: ctx.session?.nonce ?? "run"},
          retry: {attempts: ctx.cfg.RETRY_ATTEMPTS},
        }),
    },
    {
      name: "probe_behaviour",
      description:
        "Run a behaviour end to end: optional setup requests whose values feed the request under test, then the request itself. Use `capture` on a setup step to reuse a value, e.g. capture an id then DELETE /v1/items/{id}.",
      input_schema: {
        type: "object",
        properties: {
          id: {type: "string"},
          contract: {type: "object", description: "same shape as probe_api, plus an optional setup array"},
        },
        required: ["contract"],
      },
      run: ({id, contract}) =>
        probeBehaviour(
          {id: id ?? "ad-hoc", contract},
          {
            apiBase: ctx.cfg.API_BASE_URL,
            token: ctx.session?.token ?? null,
            timeoutMs: ctx.cfg.REQUEST_TIMEOUT_MS,
            substitute: {run: ctx.session?.nonce ?? "run"},
            retry: {attempts: ctx.cfg.RETRY_ATTEMPTS},
          },
        ),
    },
    {
      name: "fetch_url",
      description:
        "Fetch any URL on the app under test and return status, headers and body. Use it to look at a page's HTML when you need to know what elements exist rather than guess a selector.",
      input_schema: {
        type: "object",
        properties: {url: {type: "string"}, method: {type: "string"}},
        required: ["url"],
      },
      run: async ({url, method = "GET"}) => {
        const abs = url.startsWith("http") ? url : new URL(url, ctx.cfg.APP_BASE_URL).toString();
        const r = await request(abs, {method, timeoutMs: ctx.cfg.REQUEST_TIMEOUT_MS});
        return {status: r.status, ok: r.ok, error: r.error ?? null, body: clamp(r.text ?? r.body ?? "", 20_000)};
      },
    },
  ];
}

/* ── driving a browser ───────────────────────────────────────────────────── */

export function uiTools(ctx) {
  return [
    {
      name: "run_ui_steps",
      description:
        "Drive a real browser through declared steps and report what happened at each one. Selectors must be stated, never guessed; a selector matching several elements is reported as an ambiguous-selector finding rather than silently resolved. Actions: goto, fill, click, press, waitFor, expectText, expectVisible, expectHidden, expectCount, acceptDialog, dismissDialog.",
      input_schema: {
        type: "object",
        properties: {
          id: {type: "string"},
          steps: {type: "array", items: {type: "object"}, description: '[{"goto":"/x"},{"click":{"selector":"#a"}}]'},
        },
        required: ["steps"],
      },
      run: async ({id, steps}) => {
        const driver = await loadDriver();
        if (!driver.available) return {verdict: "skipped", reason: driver.reason, steps: []};
        const browser = await driver.chromium.launch();
        try {
          return await runUiBehaviour(
            {id: id ?? "ad-hoc", ui: {steps}},
            {
              browser,
              baseUrl: ctx.cfg.APP_BASE_URL,
              timeoutMs: ctx.cfg.REQUEST_TIMEOUT_MS,
              substitute: {run: ctx.session?.nonce ?? "run"},
            },
          );
        } finally {
          await browser.close().catch(() => {});
        }
      },
    },
  ];
}

/* ── deterministic helpers an agent should not do by hand ────────────────── */

export function tagTools() {
  return [
    {
      name: "tag_gherkin",
      description:
        "Stamp @area and @type onto Gherkin scenarios using the deterministic tag engine. Use this rather than writing tags yourself: the engine's precedence is fixed, so the same scenario always gets the same tag, which is what makes tag-based selection trustworthy.",
      input_schema: {
        type: "object",
        properties: {gherkin: {type: "string"}, area: {type: "string"}},
        required: ["gherkin", "area"],
      },
      run: ({gherkin, area}) => {
        const tagged = applyTags(gherkin, area);
        return {gherkin: tagged, untagged: validateTags(tagged)};
      },
    },
    {
      name: "explain_tag",
      description:
        "Ask why a piece of scenario text gets the @type it does, including what else matched and what it outranked. Use it when a tag surprises you.",
      input_schema: {type: "object", properties: {text: {type: "string"}}, required: ["text"]},
      run: ({text}) => explainType(text),
    },
    {
      name: "validate_tags",
      description: "Report every scenario missing @area or @type. An empty array means all are tagged.",
      input_schema: {type: "object", properties: {gherkin: {type: "string"}}, required: ["gherkin"]},
      run: ({gherkin}) => validateTags(gherkin),
    },
  ];
}

/* ── reading the run's own artifacts ─────────────────────────────────────── */

export function artifactTools(ctx) {
  const dir = () => path.join(ctx.runDir, "artifacts");
  return [
    {
      name: "read_artifact",
      description:
        "Read an artifact an earlier phase produced, by phase id (e.g. 01-scope). Your own input is already in the prompt; use this when you need more detail than the summary carried.",
      input_schema: {type: "object", properties: {phase: {type: "string"}}, required: ["phase"]},
      run: ({phase}) => {
        const f = path.join(dir(), `${phase}.json`);
        if (!fs.existsSync(f)) return {error: `no artifact for phase "${phase}" in this run`};
        const raw = JSON.parse(fs.readFileSync(f, "utf8"));
        return raw?.schema === "aqa.artifact" ? raw.data : raw;
      },
    },
    {
      name: "list_artifacts",
      description: "List the phases that have produced an artifact in this run so far.",
      input_schema: {type: "object", properties: {}},
      run: () => {
        if (!fs.existsSync(dir())) return [];
        return fs.readdirSync(dir()).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
      },
    },
  ];
}

/* ── writing test files ──────────────────────────────────────────────────── */

export function fileTools(ctx) {
  const root = path.resolve(ctx.repoRoot ?? process.cwd());
  const safe = (p) => {
    const abs = path.resolve(root, p);
    // An agent writing outside the run is not a capability this framework grants.
    if (!abs.startsWith(root + path.sep)) throw new Error(`refusing to write outside the project: ${p}`);
    return abs;
  };
  return [
    {
      name: "write_file",
      description:
        "Write a file inside the project, e.g. a .feature or a step-definition file. Paths are project-relative and cannot escape it.",
      input_schema: {
        type: "object",
        properties: {path: {type: "string"}, content: {type: "string"}},
        required: ["path", "content"],
      },
      run: ({path: p, content}) => {
        const abs = safe(p);
        fs.mkdirSync(path.dirname(abs), {recursive: true});
        fs.writeFileSync(abs, content);
        return {written: p, bytes: content.length};
      },
    },
    {
      name: "read_file",
      description: "Read a file from the project, so you can work from what is actually there rather than assume.",
      input_schema: {type: "object", properties: {path: {type: "string"}}, required: ["path"]},
      run: ({path: p}) => {
        const abs = safe(p);
        if (!fs.existsSync(abs)) return {error: `no such file: ${p}`};
        return {path: p, content: clamp(fs.readFileSync(abs, "utf8"))};
      },
    },
  ];
}

/**
 * The toolbelt granted to a phase.
 *
 * Capability IS the boundary. The Reviewer is handed no way to write a file, so
 * "the Reviewer cannot fix its own findings" is not a request in a prompt that a
 * model may or may not honour — it is a fact about what it can reach.
 */
export const TOOLSETS = {
  probe: probeTools,
  ui: uiTools,
  tags: tagTools,
  artifacts: artifactTools,
  files: fileTools,
};

export function buildTools(names, ctx) {
  return names.flatMap((n) => (TOOLSETS[n] ? TOOLSETS[n](ctx) : []));
}
