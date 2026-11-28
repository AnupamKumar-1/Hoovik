// Best-effort redaction before any cloud call. Pure logic, no SDK imports, no storage.
//
// What it does: replaces emails, URLs, money amounts, phone numbers, long digit strings and IDs,
// speaker names and (conservatively) multi-word proper names with stable placeholders such as
// <EMAIL_1> or <PERSON_2>. The same value always gets the same placeholder within one redactor.
// The placeholder -> original mapping lives only inside the redactor object (memory). It is never
// returned in a form that can be serialised by accident, stored, logged or sent.
//
// A lone first name that follows a full name ("Maria Lopez" ... "Maria") shares the full name's
// placeholder, so restoring it writes the full name back. That is the same person, but it is not a
// character-for-character copy of the original wording.
//
// What it cannot do: it is NOT anonymisation. Names that are not speakers and are not written as
// two or more capitalised words (for example a lone first name, or a lower-case name) are not
// caught. Free-text facts that identify someone indirectly are not caught. Say so wherever the
// feature is described.

export const CATEGORIES = Object.freeze(["email", "url", "money", "phone", "id", "person", "term"]);

const PREFIX = Object.freeze({ email: "EMAIL", url: "URL", money: "AMOUNT", phone: "PHONE", id: "ID", person: "PERSON", term: "TERM" });

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const MONEY_RE = /[$€£₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion|thousand|lakh|crore)\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|usd|eur|euros|gbp|inr|rupees)\b/gi;
// US-style national id: 3-2-4.
const SSN_RE = /(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g;
// A digit-led run with separators; classified by digit count below.
const PHONE_CANDIDATE_RE = /(?<![\w])\+?\(?\d[\d\s().-]{7,22}\d(?![\w])/g;
const LONG_DIGITS_RE = /(?<![\w])\d{6,}(?![\w])/g;
// Two or more capitalised words in a row (letters only, at least two letters each).
const NAME_RE = /\b\p{Lu}\p{Ll}{1,}(?:[ \t]+\p{Lu}\p{Ll}{1,})+\b/gu;

const NOT_NAME_WORDS = new Set(
  ("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december " +
    "i the a an and or but so if then okay ok yes no next last this that these those let lets thanks thank please hello hi").split(" ")
);

// Words that commonly open a sentence. A capitalised pair that starts a sentence is only treated as
// a name after these are peeled off ("Then Marcus Webb" -> "Marcus Webb"; "Then Marcus" -> nothing).
const SENTENCE_OPENERS = new Set(
  ("the a an and but so if then now well also next last first second third finally maybe yes no okay ok thanks thank please let lets we they he she it this that these those " +
    "what when where why how who which there here good great sure right exactly absolutely actually basically honestly sorry welcome hello hi hey dear today tomorrow yesterday " +
    "meanwhile however anyway once after before because since while with without for from to in on at by of as is are was were will would can could should do does did have has had " +
    "my our your their his her its all any some every each one two three four five agreed understood done noted fine perfect cool wonderful " +
    "ask call email send tell show ping remind check review update dr mr mrs ms prof mx sir").split(" ")
);

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TRAILING = /[.,;:!?)\]}'"]+$/;

const PLACEHOLDER_RE = /<([A-Z]+)_(\d+)>/g;

/** Does this text already look like one of our placeholders? */
export const isPlaceholder = (s) => typeof s === "string" && /^<[A-Z]+_\d+>$/.test(s);

function emptyCounts() {
  return Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
}

/**
 * Create a redactor. One redactor = one meeting: placeholders stay stable across every segment.
 *   names: extra person names to always redact (for example the participant list)
 *   terms: extra domain terms to always redact (whole word, case-insensitive)
 */
export function createRedactor({ names = [], terms = [] } = {}) {
  const byKey = new Map(); // `${category}|${normalised value}` -> placeholder
  const originals = new Map(); // placeholder -> first-seen original text (memory only)
  const nextN = {};
  const counts = emptyCounts(); // distinct entities per category
  const hits = emptyCounts(); // occurrences replaced per category
  const aliases = new Map(); // lower-case name token -> { value, placeholder } (parts of detected people)

  const placeholderFor = (category, value) => {
    const key = `${category}|${norm(value)}`;
    let ph = byKey.get(key);
    if (!ph) {
      nextN[category] = (nextN[category] || 0) + 1;
      ph = `<${PREFIX[category]}_${nextN[category]}>`;
      byKey.set(key, ph);
      originals.set(ph, value);
      counts[category] += 1;
    }
    return ph;
  };

  const replace = (text, category, re) =>
    text.replace(re, (m) => {
      // Keep sentence punctuation outside the placeholder (the URL and email patterns are greedy).
      const tail = category === "url" || category === "email" ? (m.match(TRAILING)?.[0] ?? "") : "";
      const core = tail ? m.slice(0, m.length - tail.length) : m;
      if (!core) return m;
      hits[category] += 1;
      return placeholderFor(category, core) + tail;
    });

  const replacePhones = (text) =>
    text.replace(PHONE_CANDIDATE_RE, (m) => {
      const digits = m.replace(/\D/g, "").length;
      const trimmed = m.replace(/[\s.-]+$/g, "");
      const lead = m.length - m.trimStart().length; // never true with the pattern; defensive
      if (digits < 9 || digits > 15 || lead) return m;
      // A bare date like 2026-11-28 has 8 digits and is skipped above; the separator check keeps
      // long unformatted runs for the id rule instead.
      if (!/[\s().+-]/.test(trimmed)) return m;
      hits.phone += 1;
      return placeholderFor("phone", trimmed) + m.slice(trimmed.length);
    });

  // Remember each part of a multi-word name so a later lone "Maria" maps to the same placeholder.
  // The first mapping for a token wins, so two people sharing a first name are never merged silently.
  const addAliases = (full, placeholder, { skipFirst = false } = {}) => {
    for (const part of full.split(/\s+/).slice(skipFirst ? 1 : 0)) {
      const key = part.toLowerCase();
      if (part.length >= 3 && !SENTENCE_OPENERS.has(key) && !NOT_NAME_WORDS.has(key) && !aliases.has(key)) aliases.set(key, { value: part, placeholder });
    }
  };

  // Multi-word capitalised names. Transcripts capitalise only sentence starts and proper nouns, so
  // two capitalised words in a row are almost always a name. At a sentence start, leading common
  // words are peeled off first, and a lone remaining word is never treated as a name.
  const replaceProperNames = (text) =>
    text.replace(NAME_RE, (m, offset, whole) => {
      const before = whole.slice(0, offset).trimEnd();
      const sentenceStart = before === "" || /[.!?:]["')\]]*$/.test(before) || /\n[ \t]*$/.test(whole.slice(0, offset));
      const parts = m.split(/([ \t]+)/); // words and the whitespace between them
      let skip = 0;
      if (sentenceStart) while (skip < parts.length && SENTENCE_OPENERS.has(parts[skip].toLowerCase()) && skip + 2 < parts.length) skip += 2;
      const rest = parts.slice(skip);
      const words = rest.filter((_p, i) => i % 2 === 0);
      if (words.length < 2 || words.some((w) => NOT_NAME_WORDS.has(w.toLowerCase()))) return m;
      const name = rest.join("");
      hits.person += 1;
      const ph = placeholderFor("person", name);
      // A sentence-initial run of three or more words may start with a verb ("Ask Maria Lopez"). The
      // whole run is redacted (the safe direction), but its first word is not kept as a name alias.
      addAliases(name, ph, { skipFirst: sentenceStart && words.length >= 3 });
      return parts.slice(0, skip).join("") + ph;
    });

  const replaceAliasesAndNames = (text, nameList) => {
    let out = text;
    for (const n of nameList) {
      // Names written with a capital stay case-sensitive so a speaker called "Will" does not erase every "will".
      const flags = n.value === n.value.toLowerCase() ? "giu" : "gu";
      const re = new RegExp(`(?<![\\p{L}\\p{N}_<])${escapeRe(n.value)}(?![\\p{L}\\p{N}_>])`, flags);
      out = out.replace(re, () => {
        hits.person += 1;
        return n.placeholder;
      });
    }
    return out;
  };

  const sortedNameList = () => {
    const list = [];
    for (const [ph, value] of originals) if (ph.startsWith("<PERSON_")) list.push({ value, placeholder: ph });
    for (const { value, placeholder } of aliases.values()) list.push({ value, placeholder });
    return list.sort((a, b) => b.value.length - a.value.length);
  };

  const termList = terms.map((t) => String(t).trim()).filter((t) => t.length >= 2).sort((a, b) => b.length - a.length);
  const extraNames = names.map((n) => String(n).trim()).filter((n) => n.length >= 2);
  for (const n of extraNames) {
    addAliases(n, placeholderFor("person", n));
  }

  /** Redact one piece of free text. Placeholders already present are left alone. */
  function redactText(input) {
    if (typeof input !== "string" || !input) return typeof input === "string" ? input : "";
    // Shield existing placeholders so no rule can rewrite them (idempotence).
    const shield = [];
    let text = input.replace(PLACEHOLDER_RE, (m) => `\u0000${shield.push(m) - 1}\u0000`);

    text = replace(text, "email", EMAIL_RE);
    text = replace(text, "url", URL_RE);
    text = replace(text, "money", MONEY_RE);
    text = replace(text, "id", SSN_RE);
    text = replacePhones(text);
    text = replace(text, "id", LONG_DIGITS_RE);
    for (const t of termList) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, "giu");
      text = text.replace(re, (m) => {
        hits.term += 1;
        return placeholderFor("term", m);
      });
    }
    text = replaceAliasesAndNames(text, sortedNameList()); // known names first, so "Dr Okafor" reuses Okafor's placeholder
    text = replaceProperNames(text);
    text = replaceAliasesAndNames(text, sortedNameList()); // names learned just now, later in the same text
    return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => shield[Number(i)]);
  }

  /**
   * Redact a segments array (or a plain string). Speaker labels become person placeholders; their
   * names are also removed from the text. Returns the same shape the transcript service produces.
   */
  function redactSegments(input) {
    const asArray = typeof input === "string" ? [{ speaker: "Unknown", start: 0, end: 0, text: input }] : input;
    if (!Array.isArray(asArray)) return input;
    // Register speakers first so their names are known before any text is scanned.
    for (const seg of asArray) {
      if (!seg || typeof seg !== "object") continue;
      const label = String(seg.speaker ?? "").replace(/\s+/g, " ").trim();
      if (!label || label.toLowerCase() === "unknown" || isPlaceholder(label)) continue;
      addAliases(label, placeholderFor("person", label));
    }
    return asArray.map((seg) => {
      if (!seg || typeof seg !== "object") return seg;
      const label = String(seg.speaker ?? "").replace(/\s+/g, " ").trim();
      let speaker = seg.speaker;
      if (label && label.toLowerCase() !== "unknown" && !isPlaceholder(label)) {
        hits.person += 1;
        speaker = placeholderFor("person", label);
      }
      return { ...seg, speaker, text: redactText(typeof seg.text === "string" ? seg.text : "") };
    });
  }

  /** Put originals back into text produced from redacted input. Local use only. */
  function restoreText(text) {
    if (typeof text !== "string" || !text) return text;
    const phs = [...originals.keys()].sort((a, b) => b.length - a.length);
    let out = text;
    for (const ph of phs) {
      const original = originals.get(ph);
      const bare = ph.slice(1, -1); // PERSON_1
      out = out.split(ph).join(original);
      // Tolerate a model that drops the angle brackets; never match PERSON_1 inside PERSON_10.
      out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${bare}(?![A-Za-z0-9_])`, "g"), () => original);
    }
    return out;
  }

  /** Restore every string inside a value (objects and arrays are copied, never mutated). */
  function restoreDeep(value) {
    if (typeof value === "string") return restoreText(value);
    if (Array.isArray(value)) return value.map(restoreDeep);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreDeep(v)]));
    return value;
  }

  const summary = () => {
    const total = Object.values(hits).reduce((a, b) => a + b, 0);
    return { counts: { ...counts }, hits: { ...hits }, entities: Object.values(counts).reduce((a, b) => a + b, 0), total };
  };

  // Deliberately no toJSON/entries accessor for the mapping.
  return Object.freeze({ redactText, redactSegments, restoreText, restoreDeep, summary });
}

/** Counts-only view that is safe to store in provenance or telemetry. */
export function safeRedactionSummary(summary) {
  const out = { applied: true, entities: 0, total: 0, byCategory: {} };
  if (!summary || typeof summary !== "object") return out;
  out.entities = Number.isInteger(summary.entities) ? summary.entities : 0;
  out.total = Number.isInteger(summary.total) ? summary.total : 0;
  for (const c of CATEGORIES) {
    const n = summary.counts?.[c];
    if (Number.isInteger(n) && n > 0) out.byCategory[c] = n;
  }
  return out;
}

export const REDACTION_NOTE =
  "Best-effort, not anonymisation. Names that are not speakers and are not written as two or more capitalised words, and facts that identify someone indirectly, are not caught.";
