// Transcript privacy setting. Pure helpers with no imports, so any service can use them
// (and tests that mock other modules are unaffected).
//
// "standard"     - cloud features (Groq deep analysis, RAG Q&A) are allowed, as before.
// "confidential" - the server refuses every path that sends this transcript to a third-party
//                  provider. Local (on-device) summaries can still be saved.
//
// Documents created before this field existed have no `privacy` value and are treated as
// standard, which keeps their behaviour unchanged.

export const PRIVACY = Object.freeze({
    STANDARD: "standard",
    CONFIDENTIAL: "confidential",
});

export const PRIVACY_VALUES = Object.freeze(Object.values(PRIVACY));

export const CONFIDENTIAL_REFUSAL = Object.freeze({
    groq: "This meeting is marked confidential, so cloud deep analysis is disabled. Use on-device analysis instead.",
    rag: "This meeting is marked confidential, so Ask-this-meeting is disabled because it sends transcript text to external AI services.",
});

export function isValidPrivacy(value) {
    return typeof value === "string" && PRIVACY_VALUES.includes(value);
}

/** Only an explicit "confidential" counts. Missing or unknown values behave as standard. */
export function isConfidential(doc) {
    return doc?.privacy === PRIVACY.CONFIDENTIAL;
}

/** Normalised value for API responses (lean documents bypass schema defaults). */
export function privacyOf(doc) {
    return isConfidential(doc) ? PRIVACY.CONFIDENTIAL : PRIVACY.STANDARD;
}

/** Returns a copy of the document with `privacy` always present. Null passes through. */
export function withPrivacy(doc) {
    if (!doc || typeof doc !== "object") return doc;
    return { ...doc, privacy: privacyOf(doc) };
}
