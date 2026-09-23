import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
    buildBrowserLogin,
    createPkcePair,
    extractCode,
    hasPasscodeField,
    parseHiddenInputs,
} from "./PkceLogin.js";

/**
 * Trimmed but structurally faithful sample of Tesla's authorize page:
 * mixed attribute order, a non-hidden input that must be ignored, and
 * an entity-escaped value.
 */
const AUTHORIZE_HTML = `
<html><body><form method="post">
  <input type="hidden" name="_csrf" value="RjRJbnBH-abc123">
  <input name="_phase" type="hidden" value="authenticate">
  <input type="hidden" value="std" name="_process">
  <input type="hidden" name="transaction_id" value="Yz9k&amp;Q1">
  <input type="hidden" name="cancel" value="">
  <input type="text" name="identity" value="not-hidden@example.com">
</form></body></html>`;

const MFA_HTML = `
<html><body><form method="post">
  <input type="hidden" name="_csrf" value="second-csrf-value">
  <input type="text" name="passcode" value="">
</form></body></html>`;

describe("parseHiddenInputs", () => {
    it("collects every hidden field regardless of attribute order", () => {
        const fields = parseHiddenInputs(AUTHORIZE_HTML);
        assert.equal(fields._csrf, "RjRJbnBH-abc123");
        assert.equal(fields._phase, "authenticate");
        assert.equal(fields._process, "std");
        assert.equal(fields.cancel, "");
    });

    it("decodes HTML entities in values", () => {
        assert.equal(parseHiddenInputs(AUTHORIZE_HTML).transaction_id, "Yz9k&Q1");
    });

    it("ignores non-hidden inputs", () => {
        assert.equal(parseHiddenInputs(AUTHORIZE_HTML).identity, undefined);
    });

    it("returns nothing for a page with no form", () => {
        assert.deepEqual(parseHiddenInputs("<html><body>nope</body></html>"), {});
    });
});

describe("hasPasscodeField", () => {
    it("recognises the multi-factor prompt", () => {
        assert.equal(hasPasscodeField(MFA_HTML), true);
    });

    it("does not fire on the plain credential form", () => {
        assert.equal(hasPasscodeField(AUTHORIZE_HTML), false);
    });
});

describe("extractCode", () => {
    it("pulls the code out of the tesla:// callback URL", () => {
        // A custom scheme, not http — `tesla://auth/callback` is the
        // only redirect_uri registered for `ownerapi`, so this is what
        // both the 302's Location header and the devtools paste carry.
        const code = extractCode(
            "tesla://auth/callback?code=c7dcabc&state=xyz" +
                "&issuer=https%3A%2F%2Fauth.tesla.com%2Foauth2%2Fv3",
        );
        assert.equal(code, "c7dcabc");
    });

    it("tolerates the whitespace a paste brings along", () => {
        assert.equal(extractCode("  tesla://auth/callback?code=abc \n"), "abc");
    });

    it("rejects a URL without a code", () => {
        assert.throws(() => extractCode("tesla://auth/callback?state=xyz"), {
            message: /carries no `code` parameter/,
        });
    });

    it("rejects something that is not a URL", () => {
        assert.throws(() => extractCode("c7dcabc"), { message: /not a URL/ });
    });
});

describe("createPkcePair", () => {
    it("produces an 86-character verifier whose S256 challenge matches", () => {
        const { verifier, challenge } = createPkcePair();
        assert.equal(verifier.length, 86);
        assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
    });

    it("is unique per call", () => {
        assert.notEqual(createPkcePair().verifier, createPkcePair().verifier);
    });
});

describe("buildBrowserLogin", () => {
    it("builds an authorize URL carrying the PKCE challenge and the login hint", () => {
        const { authorizeUrl, pkce, state } = buildBrowserLogin("alice@example.com");
        const url = new URL(authorizeUrl);
        assert.equal(url.origin, "https://auth.tesla.com");
        assert.equal(url.pathname, "/oauth2/v3/authorize");
        assert.equal(url.searchParams.get("client_id"), "ownerapi");
        assert.equal(url.searchParams.get("code_challenge"), pkce.challenge);
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(url.searchParams.get("response_type"), "code");
        assert.equal(url.searchParams.get("scope"), "openid email offline_access");
        assert.equal(url.searchParams.get("state"), state);
        assert.equal(url.searchParams.get("login_hint"), "alice@example.com");
        // The retired `https://auth.tesla.com/void/callback` fails the whole
        // flow with "redirect_uri not registered for this client_id", so pin
        // the one value Tesla still has registered for `ownerapi`.
        assert.equal(url.searchParams.get("redirect_uri"), "tesla://auth/callback");
    });
});
