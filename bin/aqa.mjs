#!/usr/bin/env node
// Entry point for `npx aqa` / a global install. Thin on purpose: it forwards to the orchestrator,
// with `report` split out so a run and its export are separate, explicit actions.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] === "report"
  ? path.join(here, "..", "pipeline", "report.mjs")
  : path.join(here, "..", "pipeline", "orchestrator.mjs");
const args = process.argv[2] === "report" ? process.argv.slice(3) : process.argv.slice(2);

spawn(process.execPath, [target, ...args], { stdio: "inherit" })
  .on("exit", (code) => process.exit(code ?? 0));
