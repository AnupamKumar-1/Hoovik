// Prompts, response schemas and chunk splitting. Pure logic; the cloud schema builder takes the
// SDK's `Schema` helper as an argument so this file never imports the SDK.
//
// The on-device adapter in the Firebase SDK only forwards message contents (systemInstruction and
// generationConfig are ignored there), so the instructions live inside the user prompt for every
// mode and the on-device schema travels as promptOptions.responseConstraint (see model.js).

import { splitSentences } from "./prepare.js";

export const SUMMARY_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    summary: { type: "string" },
    key_points: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    action_items: {
      type: "array",
      items: {
        type: "object",
        properties: { task: { type: "string" }, owner: { type: ["string", "null"] }, deadline: { type: ["string", "null"] } },
        required: ["task", "owner", "deadline"],
      },
    },
  },
  required: ["summary", "key_points", "decisions", "action_items"],
});

export function buildCloudSchema(Schema) {
  return Schema.object({
    properties: {
      summary: Schema.string(),
      key_points: Schema.array({ items: Schema.string() }),
      decisions: Schema.array({ items: Schema.object({ properties: { text: Schema.string() } }) }),
      action_items: Schema.array({
        items: Schema.object({
          properties: { task: Schema.string(), owner: Schema.string({ nullable: true }), deadline: Schema.string({ nullable: true }) },
        }),
      }),
    },
  });
}

const RULES = [
  "Reply with ONE JSON object and nothing else.",
  "Use only what is stated. Do not guess or add outside knowledge.",
  "summary: 2 to 4 sentences. key_points: up to 6 short strings.",
  "decisions: things the participants explicitly agreed or decided.",
  "action_items: tasks someone committed to or was asked to do. owner is a person named in the transcript, or null if not stated. deadline uses the transcript's own wording (for example \"Wednesday\"), or null if not stated.",
].join("\n");

export function buildChunkPrompt({ transcriptText, index = 0, total = 1 }) {
  const part = total > 1 ? `\nThis is part ${index + 1} of ${total} of one longer meeting. Cover only this part.` : "";
  return `You analyse a meeting transcript. Lines look like "[m:ss] Speaker: text".\n${RULES}${part}\n\nTranscript:\n<<<\n${transcriptText}\n>>>`;
}

const pickPartial = (p) => ({
  summary: p.summary,
  key_points: p.key_points || [],
  decisions: (p.decisions || []).map((d) => ({ text: d.text })),
  action_items: (p.action_items || []).map((a) => ({ task: a.task, owner: a.owner ?? null, deadline: a.deadline ?? null })),
});

/** The merge prompt carries only the partial analyses, never the transcript. */
export function buildMergePrompt({ partials }) {
  return [
    "Below are JSON analyses of consecutive parts of ONE meeting. Combine them into a single JSON object with the same fields.",
    "Reply with ONE JSON object and nothing else. Remove duplicates. Do not add anything that is not in the parts.",
    "Keep owner and deadline values exactly as given. summary: 2 to 4 sentences. key_points: up to 6.",
    "",
    "Parts:",
    "<<<",
    JSON.stringify(partials.map(pickPartial)),
    ">>>",
  ].join("\n");
}

const lc = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

/** Deterministic merge used when the model merge fails. Pure union with de-duplication. */
export function deterministicMerge(partials) {
  const dedupe = (items, keyOf) => {
    const seen = new Set();
    return items.filter((x) => {
      const k = lc(keyOf(x));
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const parts = partials.map(pickPartial);
  return {
    summary: parts.map((p) => p.summary).join(" "),
    key_points: dedupe(parts.flatMap((p) => p.key_points), (x) => x),
    decisions: dedupe(parts.flatMap((p) => p.decisions), (d) => d.text),
    action_items: dedupe(parts.flatMap((p) => p.action_items), (a) => a.task),
  };
}

const LINE_PREFIX = /^(\[[^\]]*\] [^:]*: )([\s\S]*)$/;

// Split the text of a single "[m:ss] Speaker: text" line in two, near the middle, on a sentence
// boundary when one exists and otherwise on a space. Both halves keep the speaker prefix.
function splitWithinLine(line) {
  const m = LINE_PREFIX.exec(line);
  const prefix = m ? m[1] : "";
  const body = m ? m[2] : line;
  const half = body.length / 2;
  const sentences = splitSentences(body);
  let cut = -1;
  if (sentences.length > 1) {
    let acc = 0;
    for (let i = 0; i < sentences.length - 1; i++) {
      acc += sentences[i].length + 1;
      cut = i + 1;
      if (acc >= half) break;
    }
    return [prefix + sentences.slice(0, cut).join(" "), prefix + sentences.slice(cut).join(" ")];
  }
  const space = body.indexOf(" ", Math.floor(half));
  cut = space > 0 ? space : body.lastIndexOf(" ", Math.floor(half));
  if (cut <= 0) return null; // one unbroken word: cannot be split without cutting it
  return [prefix + body.slice(0, cut), prefix + body.slice(cut + 1)];
}

/**
 * Split prepared chunk text into two halves, on a line boundary when there are several lines and
 * inside the line when there is only one. Returns null when it cannot be split. No text is dropped
 * (apart from the single separating space when a line is split inside).
 */
export function splitChunkText(text) {
  const lines = String(text).split("\n");
  if (lines.length < 2) return splitWithinLine(lines[0]);
  const half = text.length / 2;
  let acc = 0;
  let cut = 1;
  for (let i = 0; i < lines.length - 1; i++) {
    acc += lines[i].length + 1;
    cut = i + 1;
    if (acc >= half) break;
  }
  return [lines.slice(0, cut).join("\n"), lines.slice(cut).join("\n")];
}
