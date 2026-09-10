// Structured logging with secret redaction.
//
// Two jobs, and the second one matters more than the first:
//
//   1. A run must be debuggable after the fact. `AQA_LOG=json` emits one JSON object per line for
//      a log pipeline; the default is a human-readable line for a terminal.
//
//   2. Nothing this process has ever seen as a secret may reach a log, an artifact, or a console.
//      A QA tool holds credentials for the app under test by design, and logs are the classic way
//      they escape — into CI output, which is often world-readable on a public repo.
//
// Redaction is registration-based rather than pattern-based: the process registers the exact
// values it knows are secret (a password from config, a token from an auth response) and every
// occurrence of those, anywhere in a logged structure, is replaced. Guessing at secrets with a
// regex misses the ones you did not think of; this cannot miss one it was told about.

const SECRETS = new Set();

/** Register a value that must never appear in output. Safe to call repeatedly. */
export function registerSecret(value) {
  const v = String(value ?? "");
  // Very short values would redact innocent text; a real credential is never 1-7 characters.
  if (v.length >= 8) SECRETS.add(v);
}

export function clearSecrets() {
  SECRETS.clear();
}

/** Replace every registered secret anywhere in a value, however deeply nested. */
export function redact(value) {
  if (typeof value === "string") {
    let out = value;
    for (const s of SECRETS) {
      if (out.includes(s)) out = out.split(s).join("«redacted»");
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // A key that names a credential is redacted whatever its value, because a token read from
      // a response was never registered.
      out[k] = /^(authorization|password|token|secret|apikey|api_key|cookie)$/i.test(k) ? "«redacted»" : redact(v);
    }
    return out;
  }
  return value;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const envLevel = () => LEVELS[String(process.env.AQA_LOG_LEVEL ?? "info").toLowerCase()] ?? LEVELS.info;
const asJson = () => String(process.env.AQA_LOG ?? "").toLowerCase() === "json";

const COLOUR = { debug: "\x1b[2m", info: "", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

function emit(level, msg, fields) {
  if (LEVELS[level] < envLevel()) return;
  const safeMsg = redact(String(msg));
  const safeFields = fields ? redact(fields) : undefined;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;

  if (asJson()) {
    stream.write(JSON.stringify({ ts: new Date().toISOString(), level, msg: safeMsg, ...(safeFields ?? {}) }) + "\n");
    return;
  }
  const tail = safeFields
    ? " " + Object.entries(safeFields).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ")
    : "";
  stream.write(`${COLOUR[level]}${safeMsg}${tail}${COLOUR[level] ? RESET : ""}\n`);
}

export const log = {
  debug: (msg, fields) => emit("debug", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
  /** Write a line only in human mode — progress decoration that would be noise in a log pipeline. */
  line: (text) => {
    if (!asJson() && LEVELS.info >= envLevel()) process.stdout.write(redact(String(text)) + "\n");
  },
};
