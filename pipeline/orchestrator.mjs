#!/usr/bin/env node
// AQA orchestrator - runs the phase sequence, records state, and STOPS at each human gate.
// Resumable: approving a gate continues; rejecting sends the guarded phase back to pending.
//   node pipeline/orchestrator.mjs <scopeId> [--status] [--approve CP1] [--reject CP1 --reason "..."]
import fs from "fs";
import path from "path";
const RUNS = "pipeline/runs";
const PIPELINE = [
  ["00-preflight", null], ["01-scope", null], ["02-architecture", "CP1"], ["03-case-design", "CP2"],
  ["3b-publish", null], ["04-generate", "CP3"], ["05-targeted-run", "CP4"], ["06-self-heal", null],
  ["07-regression", null], ["08-review", "CP5"], ["09-finalise", null],
];
const scopeId = process.argv[2];
if (!scopeId) { console.error("usage: orchestrator.mjs <scopeId> [--status|--approve CP|--reject CP --reason ..]"); process.exit(1); }
const dir = path.join(RUNS, scopeId), sf = path.join(dir, "state.json");
fs.mkdirSync(dir, { recursive: true });
let st = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : { scopeId, steps: {}, gates: {}, awaiting: null };
const save = () => fs.writeFileSync(sf, JSON.stringify(st, null, 2));
const args = process.argv.slice(3);
if (args.includes("--status")) { console.log(JSON.stringify(st, null, 2)); process.exit(0); }
const gi = args.indexOf("--approve");
if (gi > -1) { const g = args[gi + 1]; st.gates[g] = { decision: "approved", at: new Date().toISOString() }; if (st.awaiting === g) st.awaiting = null; save(); console.log("approved", g); }
const rj = args.indexOf("--reject");
if (rj > -1) { const g = args[rj + 1]; st.gates[g] = { decision: "rejected" }; if (st.awaiting === g) st.awaiting = null; const guard = PIPELINE.find((p) => p[1] === g); if (guard) delete st.steps[guard[0]]; save(); console.log("rejected", g); }
for (const [id, gate] of PIPELINE) {
  if (st.steps[id]?.status !== "done") {
    // In the full framework each phase invokes its agent; here a deterministic result is recorded.
    st.steps[id] = { status: "done", at: new Date().toISOString() };
    save();
    console.log("ran", id);
  }
  // Re-check the gate on every pass, even if the guarded step already ran, so a resume
  // can never advance past an unapproved gate.
  if (gate && st.gates[gate]?.decision !== "approved") {
    st.awaiting = gate; save();
    console.log(`\n  GATE ${gate} - review the artifact, then:  node pipeline/orchestrator.mjs ${scopeId} --approve ${gate}`);
    process.exit(0);
  }
}
st.awaiting = null; save();
console.log("\n  pipeline complete for", scopeId);
