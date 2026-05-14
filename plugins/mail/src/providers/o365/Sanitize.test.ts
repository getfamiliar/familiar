import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    isSafeEmailAddress,
    sanitizeAddress,
    sanitizeDisplayName,
    UNSAFE_ADDRESS_SENTINEL,
} from "./Sanitize.js";

describe("isSafeEmailAddress", () => {
    it("accepts ordinary addresses", () => {
        assert.equal(isSafeEmailAddress("user@example.com"), true);
        assert.equal(isSafeEmailAddress("user.name+tag@sub.example.co.uk"), true);
        assert.equal(isSafeEmailAddress("USER_99@EXAMPLE.COM"), true);
    });

    it("rejects non-strings", () => {
        assert.equal(isSafeEmailAddress(null), false);
        assert.equal(isSafeEmailAddress(undefined), false);
        assert.equal(isSafeEmailAddress(123), false);
        assert.equal(isSafeEmailAddress({}), false);
    });

    it("rejects empty and over-length values", () => {
        assert.equal(isSafeEmailAddress(""), false);
        const tooLong = `${"a".repeat(250)}@x.io`; // > 254 chars
        assert.equal(isSafeEmailAddress(tooLong), false);
    });

    it("rejects path-traversal vectors", () => {
        assert.equal(isSafeEmailAddress("../etc/passwd@evil.com"), false);
        assert.equal(isSafeEmailAddress("a/b@example.com"), false);
        assert.equal(isSafeEmailAddress("a\\b@example.com"), false);
        assert.equal(isSafeEmailAddress("a..b@example.com"), false);
        assert.equal(isSafeEmailAddress("user@example..com"), false);
        assert.equal(isSafeEmailAddress(".user@example.com"), false);
        assert.equal(isSafeEmailAddress("user.@example.com"), false);
        assert.equal(isSafeEmailAddress("user@.example.com"), false);
        assert.equal(isSafeEmailAddress("user@example.com."), false);
    });

    it("rejects control characters and whitespace", () => {
        assert.equal(isSafeEmailAddress("user\x00@example.com"), false);
        assert.equal(isSafeEmailAddress("user\n@example.com"), false);
        assert.equal(isSafeEmailAddress("user @example.com"), false);
        assert.equal(isSafeEmailAddress("user@exam ple.com"), false);
    });

    it("rejects shell / quote metacharacters", () => {
        assert.equal(isSafeEmailAddress('user@"example".com'), false);
        assert.equal(isSafeEmailAddress("user@<example>.com"), false);
        assert.equal(isSafeEmailAddress("user;rm@example.com"), false);
    });

    it("rejects missing or multiple @", () => {
        assert.equal(isSafeEmailAddress("noatsign.example.com"), false);
        assert.equal(isSafeEmailAddress("a@b@c.com"), false);
    });

    it("rejects domain without TLD", () => {
        assert.equal(isSafeEmailAddress("user@localhost"), false);
        assert.equal(isSafeEmailAddress("user@example"), false);
    });
});

describe("sanitizeAddress", () => {
    it("passes safe addresses through unchanged", () => {
        const result = sanitizeAddress({ name: "Alice", address: "alice@example.com" });
        assert.equal(result.address, "alice@example.com");
        assert.equal(result.rawAddress, null);
        assert.equal(result.name, "Alice");
    });

    it("replaces unsafe addresses with the sentinel and preserves raw", () => {
        const result = sanitizeAddress({
            name: "Evil",
            address: "../etc/passwd@evil.com",
        });
        assert.equal(result.address, UNSAFE_ADDRESS_SENTINEL);
        assert.equal(result.rawAddress, "../etc/passwd@evil.com");
    });

    it("never lets path separators reach the address field", () => {
        for (const bad of [
            "a/b@evil.com",
            "a\\b@evil.com",
            "a..b@evil.com",
            "../people/admin@evil.com",
        ]) {
            const result = sanitizeAddress({ address: bad });
            assert.equal(
                result.address,
                UNSAFE_ADDRESS_SENTINEL,
                `expected sentinel for "${bad}", got "${result.address}"`,
            );
            assert.ok(!result.address.includes("/"));
            assert.ok(!result.address.includes("\\"));
            assert.ok(!result.address.includes(".."));
        }
    });
});

describe("sanitizeDisplayName", () => {
    it("returns null for empty / non-string input", () => {
        assert.equal(sanitizeDisplayName(undefined), null);
        assert.equal(sanitizeDisplayName(null), null);
        assert.equal(sanitizeDisplayName(""), null);
        assert.equal(sanitizeDisplayName("   "), null);
    });

    it("strips path separators and control characters", () => {
        assert.equal(sanitizeDisplayName("Alice/Bob"), "Alice Bob");
        assert.equal(sanitizeDisplayName("Alice\\Bob"), "Alice Bob");
        assert.equal(sanitizeDisplayName("Alice\x00Bob"), "Alice Bob");
        assert.equal(sanitizeDisplayName("Alice\nBob"), "Alice Bob");
    });

    it("collapses whitespace and trims", () => {
        assert.equal(sanitizeDisplayName("  Alice    Bob  "), "Alice Bob");
    });

    it("truncates over-long names", () => {
        const long = `${"a".repeat(250)}`;
        const result = sanitizeDisplayName(long);
        assert.ok(result !== null);
        assert.ok(result.length <= 201); // 200 + ellipsis char
        assert.ok(result.endsWith("…"));
    });
});
