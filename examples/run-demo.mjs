#!/usr/bin/env node
// One command that runs the whole demo: start the app, drive the pipeline through every gate,
// export the dashboard. Useful for a first look, and for proving the README is still true.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT ?? "4310";
const env = {
  ...process.env,
  APP_BASE_URL: `http://127.0.0.1:${PORT}`,
  API_BASE_URL: `http://127.0.0.1:${PORT}`,
  TEST_USERNAME: "demo@example.com",
  TEST_PASSWORD: "demo-pass",
};
const aqa = (...args) => spawnSync(process.execPath, [path.join(repo, "pipeline", "orchestrator.mjs"), ...args], { cwd: repo, env, stdio: "inherit" });

const app = spawn(process.execPath, [path.join(repo, "examples", "demo-app.mjs")], { env: { ...process.env, PORT }, stdio: "ignore" });
process.on("exit", () => app.kill());

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 50));
}

const spec = path.join(repo, "examples", "demo-spec.json");
aqa("run", spec);
for (const gate of ["CP1", "CP2", "CP3", "CP4", "CP5"]) {
  aqa("approve", "spec-demo-items", gate);
  aqa("run", spec);
}
spawnSync(process.execPath, [path.join(repo, "pipeline", "report.mjs")], { cwd: repo, env, stdio: "inherit" });
app.kill();
