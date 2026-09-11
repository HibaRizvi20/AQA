import {test, describe} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {parseAgentFile, loadAgent, listAgents, systemPromptFor, extractJson, HOUSE_RULES} from "./agents.mjs";
import {buildTools, TOOLSETS} from "./tools.mjs";
import {executeCases} from "./executor.mjs";
import {PHASES, ASYNC_TRACKS} from "../phases.mjs";

// These cover the agentic layer without calling a model. What can be checked
// here is exactly what matters most: that the agents' own definitions reach the
// prompt intact, and that a remit is enforced by capability rather than by
// asking a model nicely.

describe("agent definitions", () => {
  test("every agent the pipeline names has a definition on disk", () => {
    const defined = new Set(listAgents());
    const named = new Set([...PHASES, ...ASYNC_TRACKS].map((p) => p.agent).filter((a) => a && !["pre-flight", "targeted-run", "regression"].includes(a)));
    for (const a of named) {
      assert.ok(defined.has(a), `phase names agent "${a}" but agents/${a}.md does not exist`);
    }
  });

  test("all twelve agents are present, plus the single-agent baseline", () => {
    const all = listAgents();
    assert.ok(all.length >= 13, `expected 12 agents and the baseline, found ${all.length}`);
    assert.ok(all.includes("single-agent"), "the A/B baseline must exist for the comparison to be runnable");
  });

  test("frontmatter is separated from the body", () => {
    const {meta, body} = parseAgentFile("---\nname: x\ndescription: does a thing\n---\nYou are X.\nRules follow.");
    assert.equal(meta.name, "x");
    assert.equal(meta.description, "does a thing");
    assert.equal(body, "You are X.\nRules follow.");
  });

  test("a file without frontmatter is still usable", () => {
    const {meta, body} = parseAgentFile("You are X.");
    assert.deepEqual(meta, {});
    assert.equal(body, "You are X.");
  });

  test("the agent's own words reach the system prompt unaltered", () => {
    // The definitions are the product. Paraphrasing them in code would mean the
    // file a person edits is no longer the thing that runs.
    const agent = loadAgent("reviewer");
    const prompt = systemPromptFor("reviewer");
    assert.ok(prompt.startsWith(agent.system), "the definition must lead the prompt, verbatim");
    assert.ok(prompt.includes(HOUSE_RULES), "house rules follow it");
  });

  test("the does-NOT clauses survive into the prompt", () => {
    // These boundaries are the architecture. If they were dropped on the way to
    // the model, the whole separation would be decorative.
    for (const [agent, forbidden] of [
      ["reviewer", /merge|fix/i],
      ["triage-self-healer", /design cases|full regression|merge/i],
      ["test-generator", /self-heal|merge/i],
      ["scope-analyst", /write tests|touch the tracker/i],
    ]) {
      const p = systemPromptFor(agent);
      assert.match(p, /You do NOT/i, `${agent} must carry a does-NOT section`);
      assert.match(p, forbidden, `${agent}'s boundary text is missing`);
    }
  });

  test("a missing definition fails with a message naming the file", () => {
    assert.throws(() => loadAgent("no-such-agent"), /agents\/no-such-agent\.md/);
  });
});

describe("capability is the boundary", () => {
  const ctx = {cfg: {APP_BASE_URL: "http://x", API_BASE_URL: "http://x", REQUEST_TIMEOUT_MS: 100, RETRY_ATTEMPTS: 1, CONCURRENCY: 1}, session: {}, runDir: "/tmp", repoRoot: "/tmp"};

  test("a toolset resolves to real, callable tools", () => {
    const tools = buildTools(["probe"], ctx);
    assert.ok(tools.length >= 3);
    for (const t of tools) {
      assert.ok(t.name && t.description && t.input_schema, `${t.name} is missing its declaration`);
      assert.equal(typeof t.run, "function");
    }
  });

  test("an unknown toolset contributes nothing rather than throwing", () => {
    assert.deepEqual(buildTools(["nope"], ctx), []);
  });

  test("the Reviewer is handed no way to write a file", () => {
    // This is what makes "the Reviewer cannot fix its own findings" a fact about
    // its reach rather than a request in a prompt. If this test fails, the
    // separation has quietly become advisory.
    const reviewer = PHASES.find((p) => p.id === "08-review");
    assert.ok(reviewer, "the review phase must exist");
    const src = fs.readFileSync(new URL("../phases.mjs", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("async function review("), src.indexOf("async function finalise("));
    assert.doesNotMatch(block, /toolsets:\s*\[[^\]]*"files"/, "the Reviewer must not be granted file tools");
  });

  test("the file tool refuses to write outside the project", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aqa-fs-"));
    const [write] = buildTools(["files"], {...ctx, repoRoot: tmp}).filter((t) => t.name === "write_file");
    assert.throws(() => write.run({path: "../escaped.txt", content: "x"}), /outside the project/);
    assert.throws(() => write.run({path: "/etc/passwd", content: "x"}), /outside the project/);
    fs.rmSync(tmp, {recursive: true, force: true});
  });
});

describe("the runner writes the verdict, not a model", () => {
  const ctx = {cfg: {APP_BASE_URL: "http://127.0.0.1:1", API_BASE_URL: "http://127.0.0.1:1", REQUEST_TIMEOUT_MS: 200, RETRY_ATTEMPTS: 1, CONCURRENCY: 2}, session: {token: "t", nonce: "n"}};

  test("a case with neither a contract nor steps is skipped WITH a reason", async () => {
    const r = await executeCases([{id: "A", title: "nothing to run"}], ctx);
    assert.equal(r.skipped, 1);
    assert.equal(r.passed, 0);
    assert.match(r.results[0].reason, /neither a contract nor ui\.steps/);
  });

  test("an unreachable API is a fail with evidence, never a pass", async () => {
    const r = await executeCases([{id: "B", contract: {method: "GET", path: "/x", auth: false, expect: {status: 200}}}], ctx);
    assert.equal(r.failed, 1);
    assert.equal(r.passed, 0);
  });

  test("results keep input order regardless of completion order", async () => {
    const cases = ["A", "B", "C"].map((id) => ({id, contract: {method: "GET", path: "/" + id, auth: false, expect: {status: 200}}}));
    const r = await executeCases(cases, ctx);
    assert.deepEqual(r.results.map((x) => x.id), ["A", "B", "C"]);
  });

  test("an empty selection is not an error", async () => {
    const r = await executeCases([], ctx);
    assert.deepEqual([r.ran, r.passed, r.failed, r.skipped], [0, 0, 0, 0]);
  });
});

describe("phase composition", () => {
  test("the targeted run is deterministic — no agent decides a verdict", () => {
    const run = PHASES.find((p) => p.id === "05-targeted-run");
    assert.equal(run.kind, "deterministic", "a model must never be the thing that says a test passed");
  });

  test("every phase declares which half it belongs to", () => {
    for (const p of [...PHASES, ...ASYNC_TRACKS]) {
      assert.ok(["agent", "hybrid", "deterministic"].includes(p.kind), `${p.id} has no kind`);
    }
  });

  test("the five gates sit where the agents hand over", () => {
    const gates = PHASES.filter((p) => p.gate).map((p) => [p.id, p.gate]);
    assert.deepEqual(gates, [
      ["02-architecture", "CP1"],
      ["03-case-design", "CP2"],
      ["04-generate", "CP3"],
      ["05-targeted-run", "CP4"],
      ["08-review", "CP5"],
    ]);
  });

  test("async tracks carry no gate — they report and never block", () => {
    for (const t of ASYNC_TRACKS) assert.ok(!t.gate, `${t.id} must not gate a merge`);
  });
});

describe("reading an agent's answer", () => {
  test("plain JSON", () => {
    assert.deepEqual(extractJson('{"a":1}'), {a: 1});
  });
  test("JSON in a fence, which models produce despite being asked not to", () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), {a: 1});
    assert.deepEqual(extractJson('```\n{"a":1}\n```'), {a: 1});
  });
  test("JSON with a stray sentence around it", () => {
    assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps.'), {a: 1});
  });
  test("no JSON at all is a real failure and says so", () => {
    assert.throws(() => extractJson("I could not complete this."), /was not JSON/);
    assert.throws(() => extractJson(""), /returned nothing/);
  });
});
