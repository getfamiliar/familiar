import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { normalizeHandlerSpec } from "./HandlerSpec.js";

describe("normalizeHandlerSpec", () => {
    it("bare handler, no topic → falls back to fallback topic", () => {
        assert.deepEqual(normalizeHandlerSpec(undefined, "analyze", "mail"), {
            topic: "mail",
            handler: "analyze",
        });
    });

    it("bare handler, explicit topic → explicit topic wins", () => {
        assert.deepEqual(normalizeHandlerSpec("chat:telegram", "analyze", "mail"), {
            topic: "chat:telegram",
            handler: "analyze",
        });
    });

    it("slash handler, no topic → derives topic from leading segments", () => {
        assert.deepEqual(normalizeHandlerSpec(undefined, "mail/send", "anywhere"), {
            topic: "mail",
            handler: "send",
        });
    });

    it("multi-segment slash handler → colon-joined topic", () => {
        assert.deepEqual(normalizeHandlerSpec(undefined, "mail/whatsapp/send", "anywhere"), {
            topic: "mail:whatsapp",
            handler: "send",
        });
    });

    it("slash handler + explicit topic → explicit topic wins, basename extracted", () => {
        assert.deepEqual(normalizeHandlerSpec("chat", "mail/whatsapp/send", "anywhere"), {
            topic: "chat",
            handler: "send",
        });
    });

    it("strips .md suffix from bare handler", () => {
        assert.deepEqual(normalizeHandlerSpec(undefined, "send-digest.md", "mail"), {
            topic: "mail",
            handler: "send-digest",
        });
    });

    it("strips .md suffix combined with slash", () => {
        assert.deepEqual(normalizeHandlerSpec(undefined, "mail/send-digest.md", "anywhere"), {
            topic: "mail",
            handler: "send-digest",
        });
    });

    it("strips .MD (case-insensitive)", () => {
        assert.deepEqual(normalizeHandlerSpec(undefined, "send.MD", "mail"), {
            topic: "mail",
            handler: "send",
        });
    });

    it("does not strip .md when it is not a suffix", () => {
        assert.deepEqual(normalizeHandlerSpec(undefined, "send.markdown", "mail"), {
            topic: "mail",
            handler: "send.markdown",
        });
    });

    it("empty handler basename (`mail/`) → BadHandler", () => {
        assert.throws(
            () => normalizeHandlerSpec(undefined, "mail/", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadHandler");
                return true;
            },
        );
    });

    it("empty handler string → BadHandler", () => {
        assert.throws(
            () => normalizeHandlerSpec(undefined, "", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadHandler");
                return true;
            },
        );
    });

    it("leading slash with no explicit topic (`/index`) → BadHandler", () => {
        assert.throws(
            () => normalizeHandlerSpec(undefined, "/index", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadHandler");
                return true;
            },
        );
    });

    it("doubled slash (`mail//send`) → BadHandler", () => {
        assert.throws(
            () => normalizeHandlerSpec(undefined, "mail//send", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadHandler");
                return true;
            },
        );
    });

    it("derived topic with illegal characters → BadTopic", () => {
        assert.throws(
            () => normalizeHandlerSpec(undefined, "mail!/send", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadTopic");
                return true;
            },
        );
    });

    it("explicit topic with illegal characters → BadTopic", () => {
        assert.throws(
            () => normalizeHandlerSpec("bad topic", "send", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadTopic");
                return true;
            },
        );
    });

    it("fallback topic with illegal characters → BadTopic", () => {
        assert.throws(
            () => normalizeHandlerSpec(undefined, "send", "bad topic"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadTopic");
                return true;
            },
        );
    });
});
