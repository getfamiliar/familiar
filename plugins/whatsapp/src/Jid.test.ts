import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    classifyChatJid,
    isAuthorizedSender,
    normalizePhoneNumber,
    phoneNumberFromJid,
} from "./Jid.js";

describe("classifyChatJid", () => {
    it("classifies group JIDs", () => {
        assert.equal(classifyChatJid("120363012345678901@g.us"), "group");
    });

    it("classifies phone-number and LID JIDs as direct", () => {
        assert.equal(classifyChatJid("4917612345678@s.whatsapp.net"), "direct");
        assert.equal(classifyChatJid("123456789012345@lid"), "direct");
    });

    it("drops status, broadcast lists, newsletters and missing JIDs", () => {
        assert.equal(classifyChatJid("status@broadcast"), "other");
        assert.equal(classifyChatJid("1234567890@broadcast"), "other");
        assert.equal(classifyChatJid("120363123456789012@newsletter"), "other");
        assert.equal(classifyChatJid(null), "other");
        assert.equal(classifyChatJid(undefined), "other");
    });
});

describe("normalizePhoneNumber", () => {
    it("strips +, spaces, dashes and parentheses", () => {
        assert.equal(normalizePhoneNumber("+49 (176) 123-456 78"), "4917612345678");
    });

    it("drops a leading 00 international prefix", () => {
        assert.equal(normalizePhoneNumber("004917612345678"), "4917612345678");
    });

    it("returns null for non-numeric or missing input", () => {
        assert.equal(normalizePhoneNumber("not a number"), null);
        assert.equal(normalizePhoneNumber(""), null);
        assert.equal(normalizePhoneNumber(null), null);
    });
});

describe("phoneNumberFromJid", () => {
    it("extracts the number and drops the device suffix", () => {
        assert.equal(phoneNumberFromJid("4917612345678:12@s.whatsapp.net"), "4917612345678");
        assert.equal(phoneNumberFromJid("4917612345678@s.whatsapp.net"), "4917612345678");
    });

    it("returns null for LID and group JIDs", () => {
        assert.equal(phoneNumberFromJid("123456789012345@lid"), null);
        assert.equal(phoneNumberFromJid("120363012345678901@g.us"), null);
    });
});

describe("isAuthorizedSender", () => {
    it("matches equal numbers regardless of formatting", () => {
        assert.equal(isAuthorizedSender("4917612345678", "+49 176 12345678"), true);
    });

    it("rejects different or unknown numbers", () => {
        assert.equal(isAuthorizedSender("4917600000000", "4917612345678"), false);
        assert.equal(isAuthorizedSender(null, "4917612345678"), false);
        assert.equal(isAuthorizedSender("4917612345678", null), false);
    });
});
