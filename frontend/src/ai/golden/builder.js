// Deterministic helpers for building golden transcripts.
// Segment shape matches transcript_service merge_segments():
//   { start, end, speaker, text, emotion, emoji }

export const EMOJI = {
  neutral: "😐",
  joy: "😊",
  sadness: "😢",
  anger: "😠",
  fear: "😨",
  surprise: "😮",
  disgust: "🤢",
};

const WORDS_PER_SEC = 2.5;
const GAP_SEC = 0.6;

/** turns: array of [speaker, text, emotion?] -> segments with deterministic timing. */
export function buildSegments(turns) {
  let t = 0;
  return turns.map(([speaker, text, emotion = "neutral"]) => {
    const words = text.split(/\s+/).filter(Boolean).length;
    const dur = Math.max(1, Math.round((words / WORDS_PER_SEC) * 10) / 10);
    const seg = {
      start: Math.round(t * 10) / 10,
      end: Math.round((t + dur) * 10) / 10,
      speaker,
      text,
      emotion,
      emoji: EMOJI[emotion] ?? EMOJI.neutral,
    };
    t += dur + GAP_SEC;
    return seg;
  });
}

export function joinText(segments) {
  return segments.map((s) => s.text).join("\n");
}

const NOUNS = [
  "the onboarding flow", "the billing migration", "the mobile app", "the partner API",
  "the analytics dashboard", "the support queue", "the hiring plan", "the security review",
];
const ASPECTS = ["timeline", "budget", "scope", "ownership", "rollout"];
const OWNERS = ["Marcus", "Elena", "Dev", "Priya"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const TASKS = [
  "write the rollout checklist", "send the revised estimate", "book the review session",
  "update the public roadmap", "run the load test", "collect customer feedback",
];

/**
 * Template-driven meeting of `topicCount` agenda topics. Every topic has
 * exactly one decision and one owned, dated action item, each with a quote
 * that appears verbatim in the transcript.
 */
export function buildAgendaMeeting(topicCount) {
  const turns = [];
  const decisions = [];
  const actionItems = [];
  turns.push(["Priya", "Okay, let's get started. We have a full agenda today so I will keep us moving.", "neutral"]);
  for (let i = 0; i < topicCount; i++) {
    const noun = NOUNS[i % NOUNS.length];
    const aspect = ASPECTS[(i * 3) % ASPECTS.length];
    const topic = `${noun} ${aspect}`;
    const owner = OWNERS[i % OWNERS.length];
    const day = DAYS[(i * 2) % DAYS.length];
    const task = TASKS[i % TASKS.length];
    const choice = `keep ${noun} ${aspect} as planned for item ${i + 1}`;
    const decisionLine = `Let's ${choice}.`;
    const actionLine = `${owner} will ${task} for item ${i + 1} by ${day}.`;
    turns.push(["Priya", `Next topic is the ${topic}. Where do we stand on it?`, "neutral"]);
    turns.push(["Marcus", `Right now it is mostly on track. The main risk is that ${noun} depends on two other teams, and I would rather flag that early than discover it late in a review.`, "neutral"]);
    turns.push(["Elena", `That matches what I hear from customers. Several calls this week mentioned ${noun} without us bringing it up, so people clearly care about how the ${aspect} turns out.`, "joy"]);
    turns.push(["Dev", `If we hold the current plan we keep the rest of the schedule intact. The cost is that we cannot take on anything extra until the end of the month, which I think is acceptable.`, "neutral"]);
    turns.push(["Priya", `${decisionLine} ${actionLine}`, "neutral"]);
    decisions.push({ text: choice, quote: decisionLine });
    actionItems.push({ task, owner, deadline: day, quote: actionLine, attribution: { type: "explicit" } });
  }
  turns.push(["Priya", "That is everything for today. Thanks all, talk next week.", "joy"]);
  return { segments: buildSegments(turns), decisions, actionItems };
}

/** One speaker holding the floor with a very long monologue. */
export function buildGiantTurnText(sentenceCount) {
  const out = [];
  for (let i = 0; i < sentenceCount; i++) {
    out.push(
      `Point ${i + 1} of the review is that the vendor contract needs a clearer exit clause, and I want the term in section ${(i % 9) + 1} reworded before we sign anything.`
    );
  }
  return out.join(" ");
}
