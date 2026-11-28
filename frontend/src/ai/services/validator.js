// Model output validation. Tolerant parsing, strict typing, size caps, and grounding.
//
// Grounding is conservative:
//  - an owner is kept only if it is a speaker or appears as a whole word in the transcript
//    (presence);
//  - when ctx.turns is supplied, each kept owner is also labelled ownerGrounding:
//      "anchored" - a turn that matches the task's wording is spoken by the owner in first person, addresses or assigns
//                   the owner ("Dev, can you...", "Marcus will..."), or names them and they reply next
//                   (self, explicit and contextual ownership). A bare mention does not anchor;
//      "present"  - the name exists in the transcript but no turn about this task ties it to them.
//    With ctx.strictOwners, "present"-only owners are dropped (owner becomes null);
//  - a deadline is kept only if its wording appears in the transcript.
// Anchoring is a token-overlap heuristic, not proof of ownership; it will occasionally drop or
// mislabel a valid owner. Dropping is the intended failure direction for a privacy-first product.

export const CAPS = Object.freeze({
  summaryChars: 1200,
  keyPoints: 8,
  keyPointChars: 300,
  decisions: 10,
  actionItems: 15,
  textChars: 300,
  ownerChars: 60,
  deadlineChars: 60,
  quoteChars: 300,
});

const normSet = (list) => new Set(list.map((x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()));

const NON_NAME_OWNERS = normSet([
  "", "unassigned", "unknown", "none", "n/a", "na", "tbd", "nobody", "someone", "somebody", "anyone",
  "everyone", "team", "the team", "we", "i", "you", "they", "me", "us", "not stated", "unspecified",
]);
const NON_DEADLINES = normSet(["", "none", "n/a", "na", "tbd", "unknown", "unspecified", "not stated", "no deadline", "not specified"]);

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function wholeWordIn(haystack, needle) {
  if (!needle) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(needle)}([^\\p{L}\\p{N}]|$)`, "iu").test(haystack);
}

function extractBalancedObject(text, from) {
  const start = text.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { json: text.slice(start, i + 1), end: i + 1 };
  }
  return null;
}

const tryParseObject = (s) => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/** Parse model text into an object: handles code fences and surrounding prose. Never throws. */
export function parseModelJson(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ok: true, value: raw };
  if (typeof raw !== "string") return { ok: false, code: "NOT_JSON", message: "Model output was not text or an object" };
  const text = raw.trim();
  if (!text) return { ok: false, code: "EMPTY_OUTPUT", message: "Model output was empty" };
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  candidates.push(text);
  for (const c of candidates) {
    const direct = tryParseObject(c);
    if (direct) return { ok: true, value: direct };
    let from = c.indexOf("{");
    let tries = 0;
    while (from >= 0 && tries++ < 50) {
      const found = extractBalancedObject(c, from);
      if (found) {
        const parsed = tryParseObject(found.json);
        if (parsed) return { ok: true, value: parsed };
      } else if (/^\{\s*["}]/.test(c.slice(from, from + 24))) {
        break; // looks like JSON but never closes: truncated output. Do not return an inner fragment.
      }
      from = c.indexOf("{", from + 1);
    }
  }
  return { ok: false, code: "NOT_JSON", message: "No complete JSON object found (output may be truncated)" };
}

function capString(value, max, issues, path) {
  const s = value.trim();
  if (s.length <= max) return s;
  issues.push({ code: "TRUNCATED", path, message: `Truncated to ${max} characters` });
  return s.slice(0, max).trim();
}

function groundOwner(rawOwner, ctx, issues, path) {
  if (rawOwner === null || rawOwner === undefined) return null;
  if (typeof rawOwner !== "string") {
    issues.push({ code: "INVALID_TYPE", path, message: "Owner must be a string or null" });
    return null;
  }
  const owner = rawOwner.trim().slice(0, CAPS.ownerChars);
  if (NON_NAME_OWNERS.has(norm(owner))) {
    if (owner) issues.push({ code: "OWNER_NOT_A_NAME", path, message: `"${owner}" is not a person's name` });
    return null;
  }
  const exact = ctx.speakers.find((s) => norm(s) === norm(owner));
  if (exact) return exact;
  if (wholeWordIn(ctx.transcriptText, owner) || ctx.speakers.some((s) => wholeWordIn(s, owner))) return owner;
  issues.push({ code: "OWNER_UNGROUNDED", path, message: `Owner "${owner}" is not a speaker and does not appear in the transcript` });
  return null;
}

const STOP = new Set(("a an and are as at be been but by can could did do does for from get had has have he her him his i if in into is it its just let lets me my no not of on or our out over please she so some than that the their them then there these they this to up us was we were what when which who will with would you your still also then now very will shall need needs should").split(" "));
const taskTokens = (task) => [...new Set(norm(task).split(" ").filter((t) => t.length >= 3 && !STOP.has(t)))];

function speakerIsOwner(speaker, owner) {
  const a = norm(speaker);
  const b = norm(owner);
  return !!a && !!b && (a === b || wholeWordIn(a, b) || wholeWordIn(b, a));
}

const ASSIGN_VERBS = "(?:will|should|can|could|to|is going to|needs to|has to|must|shall|would you|can you|could you)";

/**
 * True if a turn matching the task wording ties the owner to it:
 *  - self:       the turn is spoken by the owner in the first person ("I will ...", "I can ...");
 *  - explicit:   the owner is addressed at the start ("Dev, can you ...") or assigned ("Marcus will ...");
 *  - contextual: the turn names the owner and the owner replies in the next turn.
 * Merely being mentioned ("... after Marcus changes the screen") does NOT anchor an owner.
 */
function ownerAnchored(task, owner, turns) {
  const tokens = taskTokens(task);
  if (!tokens.length) return false;
  const need = tokens.length === 1 ? 1 : Math.max(2, Math.ceil(tokens.length * 0.5));
  const o = escapeRe(norm(owner));
  const addressed = new RegExp(`^\\s*${o}\\b`, "i");
  const assigned = new RegExp(`(^|[^\\p{L}\\p{N}])${o}\\s+${ASSIGN_VERBS}\\b`, "iu");
  return turns.some((turn, i) => {
    const words = new Set(norm(turn.text).split(" "));
    if (tokens.filter((t) => words.has(t)).length < need) return false;
    const text = norm(turn.text);
    if (speakerIsOwner(turn.speaker, owner) && /\bi\b/.test(text)) return true;
    if (addressed.test(text) || assigned.test(text)) return true;
    const next = turns[i + 1];
    return !!next && wholeWordIn(turn.text, owner) && speakerIsOwner(next.speaker, owner);
  });
}

function groundDeadline(rawDeadline, ctx, issues, path) {
  if (rawDeadline === null || rawDeadline === undefined) return null;
  if (typeof rawDeadline !== "string") {
    issues.push({ code: "INVALID_TYPE", path, message: "Deadline must be a string or null" });
    return null;
  }
  const deadline = rawDeadline.trim().slice(0, CAPS.deadlineChars);
  if (NON_DEADLINES.has(norm(deadline))) return null;
  const core = norm(deadline).replace(/^(by|before|on|until|due|at|in|within)(\s+|$)/, "");
  if (core && ctx.normTranscript.includes(core)) return deadline;
  issues.push({ code: "DEADLINE_UNGROUNDED", path, message: `Deadline "${deadline}" does not appear in the transcript` });
  return null;
}

function cleanList(value, path, issues) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push({ code: "INVALID_TYPE", path, message: "Expected an array" });
    return [];
  }
  return value;
}

/**
 * ctx: { speakers: string[], transcriptText: string }.
 * Returns { ok, value, issues }. ok=false only when the summary itself is unusable.
 */
export function validateSummary(raw, ctx = {}) {
  const issues = [];
  const parsed = parseModelJson(raw);
  if (!parsed.ok) return { ok: false, value: null, issues: [{ code: parsed.code, path: "", message: parsed.message }] };
  const obj = parsed.value;
  const context = {
    speakers: Array.isArray(ctx.speakers) ? ctx.speakers.filter((s) => typeof s === "string") : [],
    transcriptText: typeof ctx.transcriptText === "string" ? ctx.transcriptText : "",
  };
  context.normTranscript = norm(context.transcriptText);
  context.turns = Array.isArray(ctx.turns)
    ? ctx.turns.filter((t) => t && typeof t.text === "string" && typeof t.speaker === "string")
    : null;
  context.strictOwners = ctx.strictOwners === true;

  if (obj.summary === undefined || obj.summary === null) {
    return { ok: false, value: null, issues: [{ code: "MISSING_SUMMARY", path: "summary", message: "Summary is missing" }] };
  }
  if (typeof obj.summary !== "string") {
    return { ok: false, value: null, issues: [{ code: "INVALID_TYPE", path: "summary", message: "Summary must be a string" }] };
  }
  if (!obj.summary.trim()) {
    return { ok: false, value: null, issues: [{ code: "MISSING_SUMMARY", path: "summary", message: "Summary is empty" }] };
  }
  const summary = capString(obj.summary, CAPS.summaryChars, issues, "summary");

  const keyPoints = [];
  cleanList(obj.key_points, "key_points", issues).forEach((p, i) => {
    if (typeof p !== "string") return issues.push({ code: "INVALID_TYPE", path: `key_points[${i}]`, message: "Key point must be a string" });
    if (p.trim()) keyPoints.push(capString(p, CAPS.keyPointChars, issues, `key_points[${i}]`));
  });

  const quoteOf = (item, path) => {
    if (item.quote === undefined || item.quote === null) return undefined;
    if (typeof item.quote !== "string") {
      issues.push({ code: "INVALID_TYPE", path: `${path}.quote`, message: "Quote must be a string" });
      return undefined;
    }
    return item.quote.trim() ? capString(item.quote, CAPS.quoteChars, issues, `${path}.quote`) : undefined;
  };

  const decisions = [];
  cleanList(obj.decisions, "decisions", issues).forEach((d, i) => {
    const path = `decisions[${i}]`;
    const item = typeof d === "string" ? { text: d } : d;
    if (!item || typeof item !== "object" || typeof item.text !== "string") return issues.push({ code: "INVALID_TYPE", path, message: "Decision needs a text string" });
    if (!item.text.trim()) return undefined;
    const out = { text: capString(item.text, CAPS.textChars, issues, `${path}.text`) };
    const quote = quoteOf(item, path);
    if (quote) out.quote = quote;
    decisions.push(out);
    return undefined;
  });

  const actionItems = [];
  cleanList(obj.action_items, "action_items", issues).forEach((a, i) => {
    const path = `action_items[${i}]`;
    const item = typeof a === "string" ? { task: a } : a;
    if (!item || typeof item !== "object" || typeof item.task !== "string") return issues.push({ code: "INVALID_TYPE", path, message: "Action item needs a task string" });
    if (!item.task.trim()) return undefined;
    const out = {
      task: capString(item.task, CAPS.textChars, issues, `${path}.task`),
      owner: groundOwner(item.owner, context, issues, `${path}.owner`),
      deadline: groundDeadline(item.deadline, context, issues, `${path}.deadline`),
    };
    if (out.owner !== null && context.turns) {
      if (ownerAnchored(out.task, out.owner, context.turns)) out.ownerGrounding = "anchored";
      else if (context.strictOwners) {
        issues.push({ code: "OWNER_UNANCHORED", path: `${path}.owner`, message: `Owner "${out.owner}" is in the transcript but no turn about this task ties them to it` });
        out.owner = null;
      } else out.ownerGrounding = "present";
    }
    const quote = quoteOf(item, path);
    if (quote) out.quote = quote;
    actionItems.push(out);
    return undefined;
  });

  const capList = (list, max, path) => {
    if (list.length > max) issues.push({ code: "TRUNCATED", path, message: `List capped at ${max} items` });
    return list.slice(0, max);
  };

  return {
    ok: true,
    value: {
      summary,
      key_points: capList(keyPoints, CAPS.keyPoints, "key_points"),
      decisions: capList(decisions, CAPS.decisions, "decisions"),
      action_items: capList(actionItems, CAPS.actionItems, "action_items"),
    },
    issues,
  };
}
