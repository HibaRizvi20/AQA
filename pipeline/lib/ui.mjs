// UI execution — driving a real browser, when one is available.
//
// Two constraints shape this module.
//
//   1. IT IS OPTIONAL. The pipeline's core promise is that it runs on Node alone, so Playwright
//      cannot become a hard requirement. When it is absent, a UI behaviour is reported as
//      `skipped` WITH that reason — never as a pass, and never as a failure of the app.
//
//   2. SELECTORS ARE DECLARED, NOT GUESSED. Every step names the element it acts on, and a
//      selector that matches nothing is a reported failure rather than something the runner
//      quietly works around. Guessing is how a generated suite ends up asserting on the wrong
//      button, which is exactly the defect class this framework exists to surface.

/** Attempt to load Playwright. Absence is a supported state, not an error. */
export async function loadDriver() {
  try {
    const pw = await import("playwright");
    return { available: true, chromium: pw.chromium };
  } catch {
    return {
      available: false,
      reason: "playwright is not installed — run `npm i -D playwright && npx playwright install chromium` to execute UI behaviours",
    };
  }
}

// The step vocabulary. Small on purpose: every verb maps to one unambiguous browser action, so a
// step file is readable by someone who has never seen this tool.
const VERBS = ["goto", "fill", "click", "press", "waitFor", "expectText", "expectVisible", "expectHidden", "expectCount", "acceptDialog", "dismissDialog"];

// A selector that matches several elements is AMBIGUOUS, and ambiguity is the defect class this
// framework exists to surface — a text selector reaching the wrong ✕ is how a destructive action
// gets tested by accident. So it is never resolved silently. A step that genuinely means "the
// first of several" says so with `nth`, and that intent is then visible in the artifact.
function locate(page, arg, sub) {
  const selector = sub(typeof arg === "string" ? arg : arg.selector);
  const l = page.locator(selector);
  return typeof arg === "object" && arg.nth !== undefined ? l.nth(arg.nth) : l;
}

/** Turn Playwright's strict-mode violation into the finding it actually is. */
function explain(error, arg) {
  const msg = String(error?.message ?? error).split("\n")[0];
  if (/strict mode violation/.test(msg)) {
    const n = msg.match(/resolved to (\d+) elements/)?.[1] ?? "several";
    const sel = typeof arg === "string" ? arg : arg?.selector;
    return `ambiguous selector: "${sel}" matches ${n} elements. Narrow it, or state which one with "nth".`;
  }
  return msg;
}

export function validateUiSteps(steps, where, problems) {
  if (steps === undefined) return;
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push(`${where}.ui.steps must be a non-empty array`);
    return;
  }
  for (const [i, step] of steps.entries()) {
    const verbs = Object.keys(step ?? {});
    if (verbs.length !== 1) {
      problems.push(`${where}.ui.steps[${i}] must name exactly one action, got ${verbs.length ? verbs.join(", ") : "none"}`);
      continue;
    }
    if (!VERBS.includes(verbs[0])) {
      problems.push(`${where}.ui.steps[${i}] "${verbs[0]}" is not a known action — one of ${VERBS.join(", ")}`);
    }
  }
}

/**
 * Execute one behaviour's UI steps in a fresh browser context.
 * Returns { verdict, steps } and never throws — a browser failure is a result like any other.
 */
export async function runUiBehaviour(behaviour, { browser, baseUrl, timeoutMs = 10000, substitute = {} } = {}) {
  const declared = behaviour.ui?.steps;
  if (!declared) return { verdict: "skipped", reason: "no ui.steps declared for this behaviour", steps: [] };

  const sub = (v) => (typeof v === "string" ? v.replace(/\{(\w+)\}/g, (m, k) => (k in substitute ? String(substitute[k]) : m)) : v);
  // A fresh context per behaviour: shared cookies or storage between cases is how a suite starts
  // passing only in a particular order.
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  // Native dialogs block the page until answered. A behaviour states which answer it means; with
  // no statement the dialog is dismissed, because silently accepting a "delete?" prompt would
  // turn a guard case into a destructive one.
  let dialogPolicy = "dismiss";
  const dialogsSeen = [];
  page.on("dialog", async (d) => {
    dialogsSeen.push({ type: d.type(), message: d.message() });
    await (dialogPolicy === "accept" ? d.accept() : d.dismiss());
  });

  const steps = [];
  let verdict = "pass";

  try {
    for (const step of declared) {
      const [verb] = Object.keys(step);
      const arg = step[verb];
      const started = Date.now();
      try {
        switch (verb) {
          case "goto":
            await page.goto(new URL(sub(arg), baseUrl).toString(), { waitUntil: "domcontentloaded" });
            break;
          case "fill":
            await locate(page, arg, sub).fill(sub(arg.value));
            break;
          case "click":
            await locate(page, arg, sub).click();
            break;
          case "press":
            await locate(page, arg, sub).press(arg.key);
            break;
          case "waitFor":
            await locate(page, arg, sub).waitFor({ state: arg.state ?? "visible" });
            break;
          case "acceptDialog":
            dialogPolicy = "accept";
            break;
          case "dismissDialog":
            dialogPolicy = "dismiss";
            break;
          case "expectVisible":
            await locate(page, arg, sub).waitFor({ state: "visible" });
            break;
          case "expectHidden":
            await locate(page, arg, sub).waitFor({ state: "hidden" });
            break;
          case "expectText": {
            const el = locate(page, arg, sub);
            await el.waitFor({ state: "visible" });
            const text = (await el.first().innerText()).trim();
            const want = sub(arg.toContainText ?? arg.value);
            if (!text.includes(want)) throw new Error(`expected to contain "${want}", found "${text.slice(0, 120)}"`);
            break;
          }
          case "expectCount": {
            const n = await page.locator(sub(arg.selector)).count(); // count is never nth-scoped
            if (n !== arg.is) throw new Error(`expected ${arg.is} element(s), found ${n}`);
            break;
          }
          default:
            throw new Error(`unknown action "${verb}"`);
        }
        steps.push({ step: `${verb} ${JSON.stringify(arg)}`.slice(0, 160), ok: true, ms: Date.now() - started });
      } catch (e) {
        verdict = "fail";
        steps.push({ step: `${verb} ${JSON.stringify(arg)}`.slice(0, 160), ok: false, ms: Date.now() - started, error: explain(e, arg) });
        break; // a broken step invalidates everything after it; continuing would report noise
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  return { verdict, steps, dialogs: dialogsSeen, failed: steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.error}`) };
}
