// POC for issue #12 — can a free-tier model place an Israeli bank string that
// no rule and no local suggestion could?
//
// This is a throwaway measurement, not a feature. It touches no database, adds
// no dependency, and writes nothing. The only question it answers is the one
// that decides whether the rest of #12 is worth building: ACCURACY on real
// merchant strings, and specifically on the hard ones.
//
// METHOD.
//
//   1. Normalize every fixture case through `normalizeDescription`, so the
//      model sees exactly the match text production would send it.
//   2. Deduplicate. ADR 0003's unit is the match text, not the entry, so a
//      hundred transactions at one supermarket are one lookup, forever. The
//      run reports the collapse.
//   3. Drop anything the egress filter refuses to send. A P2P string
//      normalizes to a PERSON'S NAME, which ADR 0003's "only the match text
//      may leave" does not distinguish and should. These are also worthless
//      to look up, so the filter costs nothing.
//   4. Batch what is left into one request per BATCH_SIZE texts. ADR 0003
//      caps lookups per text; it says nothing about calls, and batching is
//      what makes a free tier sufficient for a cold start.
//   5. Score against the fixture's labels.
//
// THE OUTPUT SHAPE IS THE DESIGN CLAIM. The model answers with a `builtin_key`
// from `default-categories.ts` — a closed, shipped enum — never a category
// name and never a uuid. Moni resolves the key locally through the same
// `builtinKeyToId` map `loadContext` already builds. So the prompt is a
// constant, the user's category tree never leaves, and a rename cannot break
// anything, because `builtin_key` is the identity that survives renames
// (docs/design/categorization.md §5).
//
// Usage:
//   MONI_LLM_API_KEY=... npm run merchant-lookup:poc
//
// Defaults to Gemini Flash-Lite over its OpenAI-compatible endpoint. Any
// provider speaking that shape works without a code change:
//   MONI_LLM_BASE_URL=https://api.groq.com/openai/v1 MONI_LLM_MODEL=...
import "dotenv/config";
import { z } from "zod";
import { normalizeDescription } from "@/lib/categorization/normalize";
import { DEFAULT_CATEGORIES } from "@/lib/categorization/default-categories";
import { LOOKUP_CASES, type LookupCase } from "./fixtures/merchant-lookup-cases";

const API_KEY = process.env.MONI_LLM_API_KEY;
const BASE_URL =
  process.env.MONI_LLM_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai";
// The `-latest` alias, deliberately: a pinned Gemini version gets closed to
// new API keys without warning, and a POC that 404s is worse than one that
// drifts. Pin via MONI_LLM_MODEL when comparing two models.
const MODEL = process.env.MONI_LLM_MODEL ?? "gemini-flash-lite-latest";

/**
 * Texts per request — and NOT a free cost knob, which is the most surprising
 * thing this POC found.
 *
 * At 25, three real restaurants came back as groceries with high confidence
 * and the correct brand named. Isolated, the same three texts are 3/3. A
 * numbered list is one completion, and per-item attention degrades as the
 * list grows, so the batch size is a correctness parameter wearing a cost
 * parameter's clothes. Telling the model the items are independent does not
 * fix it — measured, no change.
 *
 * Measured on this fixture: 25 → 87% / 77% hard. 10 → 93% / 85% hard.
 * Below ~10 the free tier starts refusing on requests-per-minute, so 10 is
 * where accuracy and the quota meet.
 */
const BATCH_SIZE = Number(process.env.MONI_LLM_BATCH_SIZE ?? 10);

/** What the model may answer when it does not recognize a merchant. Having an
 * explicit escape is what makes "hallucinated confidently" a measurable
 * outcome rather than an invisible one. */
const UNKNOWN = "unknown";

// ---------------------------------------------------------------------------
// Egress filter
// ---------------------------------------------------------------------------

/**
 * Match texts that must never reach a third party, even though ADR 0003
 * permits "the match text".
 *
 * A person-to-person transfer normalizes to a person's name — `ביט העברה
 * מישראל כהן` is not a merchant, it is an individual who never consented to
 * anything. Leaking that is categorically worse than leaking `שופרסל`, and it
 * is the one case the ADR's rule does not separate out.
 *
 * Substrings of the NORMALIZED text, matching the built-in table's own
 * convention (docs/design/categorization.md §6).
 */
const NEVER_SEND = ["ביט העברה", "פייבוקס", "paybox", "העברה ל", "העברה מ", "העברת כספים", "bit "];

function blocksEgress(matchText: string): boolean {
  return NEVER_SEND.some((needle) => matchText.includes(needle));
}

// ---------------------------------------------------------------------------
// The taxonomy the model classifies into
// ---------------------------------------------------------------------------

/** Every leaf key, with its parent for context. Parents are not offered as
 * answers: a suggestion should land on "Groceries", not on "Food & Drink". */
function leafCatalog(): { key: string; label: string }[] {
  return DEFAULT_CATEGORIES.flatMap((group) =>
    group.children.map((child) => ({
      key: child.key,
      label: `${group.name} / ${child.name}`,
    })),
  );
}

const CATALOG = leafCatalog();
const VALID_KEYS = new Set(CATALOG.map((c) => c.key));

const SYSTEM_PROMPT = [
  "You classify merchant strings taken from Israeli bank and credit-card statements.",
  "The strings are normalized: lowercased, punctuation and long digit runs removed. Most are Hebrew; some are transliterated or truncated brand names.",
  "",
  "Answer with a category key from this closed list. Never invent a key.",
  "",
  ...CATALOG.map((c) => `  ${c.key} — ${c.label}`),
  "",
  `If you do not recognize the merchant, or the string names no counterparty at all, answer "${UNKNOWN}". Guessing is worse than abstaining: a wrong answer gets one-click accepted by a human and sticks.`,
  "",
  // `brand` is the abstention lever, not decoration. Asking for a category
  // invites a plausible one to be assembled out of the words in the string —
  // `א.מ.י.ר שיווק והפצה` became Groceries because "שיווק" reads like trade.
  // Asking WHICH BUSINESS this is has no such fallback: either a specific
  // named organization comes to mind or nothing does. `confidence` is the
  // self-report, which is weaker but free once the brand question is asked.
  "For each string also answer:",
  '  brand      — the specific named business or organization you recognize, or "" if none. A generic trade description ("marketing and distribution", "a supermarket") is NOT a brand; leave it empty.',
  "  confidence — high | medium | low. Use high only when you recognize the actual named entity.",
  "",
  'If brand is "", the key must be "unknown". Do not infer a category from what the words in the string suggest.',
  "",
  // MEASURED, and the single most expensive thing left out of a first draft.
  // Six groceries followed by three restaurants made all three restaurants
  // come back as groceries, high confidence, correct brand. Isolated, the
  // same three texts are 3/3. A numbered list is one completion, so the list
  // itself is context; the batch is a cost optimization that silently became
  // a correctness variable.
  "Each numbered string is an INDEPENDENT question about a different merchant.",
  "The strings are unrelated to each other and are in no meaningful order. Never let one string's category influence another's, and never assume a run of similar answers should continue.",
  "",
  'Reply with JSON only: {"results":[{"i":<index>,"key":"<key>","brand":"<name or empty>","confidence":"high|medium|low","why":"<max 6 words>"}]}',
  "Return exactly one result per input index.",
].join("\n");

// ---------------------------------------------------------------------------
// The provider call
// ---------------------------------------------------------------------------

const ResponseSchema = z.object({
  results: z.array(
    z.object({
      i: z.number().int(),
      key: z.string(),
      brand: z.string().default(""),
      confidence: z.enum(["high", "medium", "low"]).default("low"),
      // Optional: at batch size 1 the model routinely drops it. `why` is
      // debugging output, so a missing one must not fail the run — but a
      // missing `key` still should.
      why: z.string().default(""),
    }),
  ),
});

interface Answer {
  key: string;
  brand: string;
  confidence: "high" | "medium" | "low";
  why: string;
}

/**
 * The suggestion Moni would actually show, after the local guard.
 *
 * The model's raw answer is not the product. A low-confidence answer is
 * dropped here rather than rendered — accepting a suggestion LOCKS the
 * category (categorization.md §4), so a wrong chip costs far more than a
 * missing one.
 *
 * Note what this does NOT gate on. Asking for `brand` in the prompt is what
 * stopped the hallucinations — measured, 2 to 0 — but requiring one locally
 * is a different rule and a wrong one: `עמלת ניהול חשבון` and `ועד בית` name
 * no business and are categorizable precisely because they are generic. The
 * brand question earns its place by changing what the model says, not by
 * filtering what it said.
 */
function guarded(answer: Answer): string {
  if (answer.confidence === "low") return UNKNOWN;
  return answer.key;
}

/** Strips a ```json fence some providers wrap JSON in despite being asked
 * for an object. Cheaper than arguing with each one's response_format. */
function unfence(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return (fenced ? fenced[1] : content).trim();
}

async function classifyBatch(texts: string[], offset: number): Promise<Map<number, Answer>> {
  const numbered = texts.map((text, i) => `${offset + i}. ${text}`).join("\n");

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: numbered },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}\n${await response.text()}`);
  }

  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error(`No content in response: ${JSON.stringify(payload).slice(0, 400)}`);

  const parsed = ResponseSchema.parse(JSON.parse(unfence(content)));

  const answers = new Map<number, Answer>();
  for (const result of parsed.results) {
    // An off-list key is a protocol violation, not a suggestion. Production
    // would drop it; here it is worth seeing, so it is recorded as-is and
    // scored as a miss.
    answers.set(result.i, {
      key: result.key,
      brand: result.brand,
      confidence: result.confidence,
      why: result.why,
    });
  }
  return answers;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Merchant strings are Hebrew and get printed beside LTR keys and marks.
 * Without isolation the terminal reorders the whole line
 * (docs/design/categorization.md §12). */
function bidi(text: string): string {
  return `⁨${text}⁩`;
}

interface Scored {
  case: LookupCase;
  matchText: string;
  /** What the model said, before the guard. */
  raw: string;
  /** What Moni would show, after `guarded`. */
  got: string;
  brand: string;
  confidence: string;
  why: string;
  correct: boolean;
  /** The guard turned a model answer into an abstention. */
  suppressed: boolean;
}

function report(scored: Scored[], label: string): void {
  if (scored.length === 0) return;
  const hits = scored.filter((s) => s.correct).length;
  const pct = ((hits / scored.length) * 100).toFixed(0);
  console.log(`\n${label}: ${hits}/${scored.length}  (${pct}%)`);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error(
      "MONI_LLM_API_KEY is not set.\n" +
        "Get a free key at https://aistudio.google.com/apikey and put it in .env,\n" +
        "or point MONI_LLM_BASE_URL / MONI_LLM_MODEL at any OpenAI-compatible provider.",
    );
    process.exit(1);
  }

  for (const testCase of LOOKUP_CASES) {
    if (testCase.expect !== UNKNOWN && !VALID_KEYS.has(testCase.expect)) {
      console.error(`Fixture error: "${testCase.expect}" is not a leaf key in DEFAULT_CATEGORIES.`);
      process.exit(1);
    }
  }

  // A comma-separated substring filter, for isolating a handful of cases
  // without editing the fixture. Its real use is the control run: pull three
  // suspect merchants out of the batch that may have led them astray.
  const only = (process.env.MONI_LLM_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const cases =
    only.length === 0
      ? LOOKUP_CASES
      : LOOKUP_CASES.filter((c) => only.some((needle) => c.raw.includes(needle)));

  // Step 1-2: normalize, then collapse to distinct texts. One text, one
  // lookup, for all time (ADR 0003).
  const byText = new Map<string, LookupCase[]>();
  for (const testCase of cases) {
    const matchText = normalizeDescription(testCase.raw);
    const bucket = byText.get(matchText);
    if (bucket) bucket.push(testCase);
    else byText.set(matchText, [testCase]);
  }

  // Step 3: the egress filter.
  const sendable: string[] = [];
  const withheld: string[] = [];
  for (const matchText of byText.keys()) {
    (blocksEgress(matchText) ? withheld : sendable).push(matchText);
  }

  const batches = Math.ceil(sendable.length / BATCH_SIZE);
  console.log(`model      ${MODEL}`);
  console.log(`endpoint   ${BASE_URL}`);
  console.log(
    `\n${cases.length} cases → ${byText.size} distinct match texts → ` +
      `${sendable.length} sent (${withheld.length} withheld) → ${batches} request(s)`,
  );

  if (withheld.length > 0) {
    console.log("\nwithheld from egress (P2P — these carry people, not merchants):");
    for (const text of withheld) console.log(`  ${bidi(text)}`);
  }

  // Step 4: one call per batch.
  const answers = new Map<string, Answer>();
  for (let start = 0; start < sendable.length; start += BATCH_SIZE) {
    const slice = sendable.slice(start, start + BATCH_SIZE);
    process.stdout.write(`\nrequest ${start / BATCH_SIZE + 1}/${batches} … `);
    const batch = await classifyBatch(slice, start);
    for (const [index, answer] of batch) {
      const text = sendable[index];
      if (text !== undefined) answers.set(text, answer);
    }
    console.log(`${batch.size} answers`);
  }

  // Step 5: score. Every case sharing a match text gets that text's answer —
  // which is the cache's behaviour, made visible.
  const scored: Scored[] = [];
  for (const [matchText, cases] of byText) {
    if (blocksEgress(matchText)) continue;
    const answer: Answer = answers.get(matchText) ?? {
      key: "<no answer>",
      brand: "",
      confidence: "low",
      why: "",
    };
    const shown = guarded(answer);
    for (const testCase of cases) {
      scored.push({
        case: testCase,
        matchText,
        raw: answer.key,
        got: shown,
        brand: answer.brand,
        confidence: answer.confidence,
        why: answer.why,
        correct: shown === testCase.expect,
        suppressed: shown !== answer.key,
      });
    }
  }

  console.log("\n─── results ────────────────────────────────────────────────");
  for (const row of scored) {
    const mark = row.correct ? "✓" : "✗";
    const hard = row.case.hard ? " ⚑" : "  ";
    console.log(`${mark}${hard} ${bidi(row.matchText)}`);
    console.log(
      `      got ${row.got}${row.correct ? "" : `   expected ${row.case.expect}`}` +
        (row.suppressed ? `   [guard suppressed ${row.raw}]` : "") +
        `   ${row.confidence}` +
        (row.brand ? ` · ${bidi(row.brand)}` : " · no brand") +
        (row.why ? `   (${row.why})` : ""),
    );
  }

  report(scored, "overall   ");
  report(
    scored.filter((s) => !s.case.hard),
    "easy      ",
  );
  report(
    scored.filter((s) => s.case.hard),
    "hard ⚑    ",
  );

  // The failure modes that matter more than the headline number.
  const hallucinated = scored.filter((s) => s.case.expect === UNKNOWN && s.got !== UNKNOWN);
  const hallucinatedRaw = scored.filter((s) => s.case.expect === UNKNOWN && s.raw !== UNKNOWN);
  const offList = scored.filter((s) => s.got !== UNKNOWN && !VALID_KEYS.has(s.got));
  // The guard's cost: a correct answer thrown away for want of confidence.
  const overSuppressed = scored.filter((s) => s.suppressed && s.raw === s.case.expect);

  console.log(
    `\nhallucinated on unplaceable strings: ${hallucinated.length}` +
      ` (model said ${hallucinatedRaw.length}, guard caught ${hallucinatedRaw.length - hallucinated.length})`,
  );
  console.log(`correct answers lost to the guard:   ${overSuppressed.length}`);
  console.log(`off-list keys returned:              ${offList.length}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
