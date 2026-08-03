import { z } from "zod";
import { DEFAULT_CATEGORIES } from "./default-categories";

export const UNKNOWN = "unknown";
export const PROMPT_VERSION = 1;

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
export const NEVER_SEND = [
  "ביט העברה",
  "פייבוקס",
  "paybox",
  "העברה ל",
  "העברה מ",
  "העברת כספים",
  "bit ",
];

export function blocksEgress(matchText: string): boolean {
  return NEVER_SEND.some((needle) => matchText.includes(needle));
}

/** Every leaf key, with its parent for context. Parents are not offered as
 * answers: a suggestion should land on "Groceries", not on "Food & Drink". */
export function leafCatalog(): { key: string; label: string }[] {
  return DEFAULT_CATEGORIES.flatMap((group) =>
    group.children.map((child) => ({
      key: child.key,
      label: `${group.name} / ${child.name}`,
    })),
  );
}

export const CATALOG = leafCatalog();
export const VALID_KEYS = new Set(CATALOG.map((c) => c.key));

export const SYSTEM_PROMPT = [
  "You classify merchant strings taken from Israeli bank and credit-card statements.",
  "The strings are normalized: lowercased, punctuation and long digit runs removed. Most are Hebrew; some are transliterated or truncated brand names.",
  "",
  "Answer with a category key from this closed list. Never invent a key.",
  "",
  ...CATALOG.map((c) => `  ${c.key} — ${c.label}`),
  "",
  `If you do not recognize the merchant, or the string names no counterparty at all, answer "${UNKNOWN}". Guessing is worse than abstaining: a wrong answer gets one-click accepted by a human and sticks.`,
  "",
  "For each string also answer:",
  '  brand      — the specific named business or organization you recognize, or "" if none. A generic trade description ("marketing and distribution", "a supermarket") is NOT a brand; leave it empty.',
  "  confidence — high | medium | low. Use high only when you recognize the actual named entity.",
  "",
  'If brand is "", the key must be "unknown". Do not infer a category from what the words in the string suggest.',
  "",
  "Each numbered string is an INDEPENDENT question about a different merchant.",
  "The strings are unrelated to each other and are in no meaningful order. Never let one string's category influence another's, and never assume a run of similar answers should continue.",
  "",
  'Reply with JSON only: {"results":[{"i":<index>,"key":"<key>","brand":"<name or empty>","confidence":"high|medium|low","why":"<max 6 words>"}]}',
  "Return exactly one result per input index.",
].join("\n");

export const ResponseSchema = z.object({
  results: z.array(
    z.object({
      i: z.number().int(),
      key: z.string(),
      brand: z.string().default(""),
      confidence: z.enum(["high", "medium", "low"]).default("low"),
      why: z.string().default(""),
    }),
  ),
});

export interface Answer {
  key: string;
  brand: string;
  confidence: "high" | "medium" | "low";
  why: string;
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function getLlmConfig(): LlmConfig | null {
  const apiKey = process.env.MONI_LLM_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl:
      process.env.MONI_LLM_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
    model: process.env.MONI_LLM_MODEL ?? "gemini-flash-lite-latest",
  };
}

/**
 * The suggestion Moni would actually show, after the local guard.
 *
 * Drops `confidence === "low"`. Does NOT gate on an empty `brand`.
 */
export function guarded(answer: Answer): string {
  if (answer.confidence === "low") return UNKNOWN;
  if (!VALID_KEYS.has(answer.key)) return UNKNOWN;
  return answer.key;
}

function unfence(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return (fenced ? fenced[1] : content).trim();
}

export async function classifyBatch(
  texts: string[],
  offset: number,
  config: LlmConfig,
): Promise<Map<number, Answer>> {
  const numbered = texts.map((text, i) => `${offset + i}. ${text}`).join("\n");

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
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
    answers.set(result.i, {
      key: result.key,
      brand: result.brand,
      confidence: result.confidence,
      why: result.why,
    });
  }
  return answers;
}
