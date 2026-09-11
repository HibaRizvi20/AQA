// Turning a run into the three things the scorer needs.
//
// Both architectures must be reduced to the SAME shape before scoring, or the
// comparison measures reporting style rather than QA quality. A single agent
// that writes one flat list and a pipeline that spreads its conclusions across
// eleven artifacts have to arrive here looking alike.
//
// The shape:
//
//   defects       what it claims is wrong
//   observations  every suspicious thing it saw, and what it classified it as
//   corrections   where a later step overturned an earlier one
//
// One rule matters more than the rest: a behaviour the pipeline examined and
// concluded was VALID is not a defect, and must not be collected as one. That is
// the whole point of triage, and collecting it anyway would erase the difference
// the benchmark exists to detect.

const str = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

/** Normalise one triage row into an observation the scorer can grade. */
function toObservation(t) {
  return {
    observable: t.observable ?? t.detail ?? t.id,
    id: t.id,
    classification: t.classification,
    evidence: t.evidence ?? null,
  };
}

/**
 * A defect report, with the five evidence parts kept separate where given.
 *
 * Tolerant of malformed entries on purpose. A model occasionally returns a null
 * or a bare string inside an array, and a benchmark that throws on that produces
 * no data at all — which is a far worse outcome than scoring a vague report as
 * the vague report it is.
 */
function toDefect(src, fallbackId) {
  if (src == null) return {id: fallbackId, severity: null, area: null, summary: "(empty report)", evidence: null};
  if (typeof src !== "object") {
    return {id: fallbackId, severity: null, area: null, summary: String(src), evidence: null};
  }
  return {
    id: src.id ?? fallbackId,
    severity: src.severity ?? null,
    area: src.area ?? null,
    summary: src.summary ?? src.detail ?? str(src),
    observed: src.observed ?? src.actual ?? null,
    expected: src.expected ?? null,
    rule: src.rule ?? null,
    reproduction: src.reproduction ?? (src.request ? `${src.request.method} ${src.request.path}` : null),
    why_a_defect: src.why_a_defect ?? null,
    evidence: [src.evidence, src.detail, src.rule, src.reproduction, src.why_a_defect].filter(Boolean).join(" · ") || null,
  };
}

/* ── Mode B · the twelve-agent pipeline ──────────────────────────────────── */

export function collectPipeline(artifacts = {}) {
  const triage = artifacts["06-self-heal"] ?? {};
  const review = artifacts["08-review"] ?? {};
  const preflight = artifacts["00-preflight"] ?? {};
  const perf = artifacts["a09-performance"] ?? {};

  const triaged = triage.triaged ?? [];

  // Corrections, from both places that can make one.
  const corrections = [
    ...(triage.corrections ?? []).map((c) => ({...c, by_phase: c.by_phase ?? "06-self-heal"})),
    ...(review.corrections ?? []).map((c) => ({...c, by_phase: c.by_phase ?? "08-review"})),
  ];

  // A defect is something still standing as a defect AFTER triage and review.
  // Anything a later phase overturned to "valid" is dropped, because rejecting a
  // false alarm is the behaviour under test, not a report to be counted.
  const overturnedToValid = new Set(
    corrections.filter((c) => c.corrected_to === "valid").map((c) => c.subject_id),
  );

  const defects = [
    ...triaged
      .filter((t) => t.classification === "product_defect" && !overturnedToValid.has(t.id))
      .map((t) => toDefect(t)),
    // Pre-flight can find a blocking problem before any test exists.
    ...(preflight.findings ?? [])
      .filter((f) => f.severity === "blocking" && !overturnedToValid.has(f.id))
      .map((f) => toDefect({...f, summary: f.detail}, f.id)),
    ...(perf.findings ?? []).map((f) => toDefect({...f, summary: f.evidence}, f.id)),
  ];

  // Corrections that RAISED something to a defect belong in the list too.
  for (const c of corrections.filter((x) => x.corrected_to === "defect")) {
    if (!defects.some((d) => d.id === c.subject_id)) {
      defects.push(toDefect({id: c.subject_id, summary: c.reasoning, why_a_defect: c.reasoning}, c.subject_id));
    }
  }

  return {
    defects,
    observations: triaged.map(toObservation),
    corrections,
    interpretation: artifacts["01-scope"]?.interpretation ?? "",
    ambiguities: artifacts["01-scope"]?.ambiguities ?? [],
    coverageGaps: review.coverage_gaps ?? [],
    cases: artifacts["03-case-design"]?.cases ?? [],
    execution: artifacts["05-targeted-run"] ?? null,
  };
}

/* ── Mode A · the single agent ───────────────────────────────────────────── */

export function collectSingle(out = {}) {
  // The single agent reports one flat list. It has no later phase to overturn an
  // earlier one, so corrections is empty by construction — that structural zero
  // is a finding about the architecture, not a gap in the collection.
  const corrections = out.corrections ?? [];

  const observations = (out.observations ?? out.triage ?? []).map((t) => ({
    observable: t.observable ?? t.summary ?? t.id,
    id: t.id,
    classification: t.classification,
    evidence: t.evidence ?? null,
  }));

  return {
    defects: (out.defects ?? []).map((d, i) => toDefect(d, `SA-${i + 1}`)),
    observations,
    corrections,
    interpretation: out.interpretation ?? "",
    ambiguities: out.ambiguities ?? [],
    coverageGaps: out.coverage_gaps ?? [],
    cases: out.cases ?? [],
    execution: null,
  };
}
