import { describe, it, expect } from "vitest";
import {
    PRIVACY,
    isConfidential,
    isValidPrivacy,
    privacyOf,
    withPrivacy,
} from "../../../src/utils/privacy.utils.js";

describe("privacy utils", () => {
    it("treats only an explicit confidential value as confidential", () => {
        expect(isConfidential({ privacy: "confidential" })).toBe(true);
        expect(isConfidential({ privacy: "standard" })).toBe(false);
        expect(isConfidential({})).toBe(false);
        expect(isConfidential(null)).toBe(false);
        expect(isConfidential({ privacy: "CONFIDENTIAL" })).toBe(false);
    });

    it("treats documents created before the field existed as standard", () => {
        expect(privacyOf({ meetingCode: "OLD" })).toBe(PRIVACY.STANDARD);
        expect(withPrivacy({ meetingCode: "OLD" })).toEqual({ meetingCode: "OLD", privacy: "standard" });
    });

    it("withPrivacy keeps the stored value and does not mutate its input", () => {
        const doc = { meetingCode: "X", privacy: "confidential" };
        const out = withPrivacy(doc);
        expect(out.privacy).toBe("confidential");
        expect(out).not.toBe(doc);
        expect(withPrivacy(null)).toBeNull();
    });

    it("validates the two allowed values only", () => {
        expect(isValidPrivacy("standard")).toBe(true);
        expect(isValidPrivacy("confidential")).toBe(true);
        for (const bad of ["", "private", "Confidential", null, undefined, 1, {}, ["standard"]]) {
            expect(isValidPrivacy(bad)).toBe(false);
        }
    });
});
