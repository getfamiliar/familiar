import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decodeMimeEncodedWords } from "./MimeEncodedWord.js";

describe("decodeMimeEncodedWords", () => {
    it("decodes the Q encoding Tailscale sends", () => {
        assert.equal(decodeMimeEncodedWords("=?utf-8?q?J=C3=BCrgen_Wei=C3=9F?="), "Jürgen Weiß");
    });

    it("decodes the B encoding and other charsets", () => {
        assert.equal(decodeMimeEncodedWords("=?UTF-8?B?SsO8cmdlbiBXZWnDnw==?="), "Jürgen Weiß");
        assert.equal(decodeMimeEncodedWords("=?iso-8859-1?Q?M=FCller?="), "Müller");
    });

    it("joins adjacent words and keeps surrounding text", () => {
        assert.equal(decodeMimeEncodedWords("=?utf-8?q?J=C3=BC?= =?utf-8?q?rgen?="), "Jürgen");
        assert.equal(decodeMimeEncodedWords("Dr. =?utf-8?q?M=C3=BCller?= jr."), "Dr. Müller jr.");
    });

    it("leaves plain and malformed values unchanged", () => {
        assert.equal(decodeMimeEncodedWords("Jürgen Weiß"), "Jürgen Weiß");
        assert.equal(decodeMimeEncodedWords("=?utf-8?q?bad=Z1?="), "=?utf-8?q?bad=Z1?=");
        assert.equal(decodeMimeEncodedWords("=?no-such-charset?q?x?="), "=?no-such-charset?q?x?=");
    });
});
