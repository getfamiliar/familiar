import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseHandlerSpec } from "./HandlerSpecParser.js";

describe("parseHandlerSpec", () => {
    it("bare handler, no topic → falls back to fallback topic", () => {
        assert.deepEqual(parseHandlerSpec(undefined, "analyze", "mail"), {
            topic: "mail",
            handler: "analyze",
        });
    });

    it("bare handler, explicit topic → explicit topic wins", () => {
        assert.deepEqual(parseHandlerSpec("chat:telegram", "analyze", "mail"), {
            topic: "chat:telegram",
            handler: "analyze",
        });
    });

    it("slash handler, no topic → derives topic from leading segments", () => {
        assert.deepEqual(parseHandlerSpec(undefined, "mail/send", "anywhere"), {
            topic: "mail",
            handler: "send",
        });
    });

    it("multi-segment slash handler → colon-joined topic", () => {
        assert.deepEqual(parseHandlerSpec(undefined, "mail/whatsapp/send", "anywhere"), {
            topic: "mail:whatsapp",
            handler: "send",
        });
    });

    it("slash handler + explicit topic → explicit topic wins, basename extracted", () => {
        assert.deepEqual(parseHandlerSpec("chat", "mail/whatsapp/send", "anywhere"), {
            topic: "chat",
            handler: "send",
        });
    });

    it("strips .md suffix from bare handler", () => {
        assert.deepEqual(parseHandlerSpec(undefined, "send-digest.md", "mail"), {
            topic: "mail",
            handler: "send-digest",
        });
    });

    it("strips .md suffix combined with slash", () => {
        assert.deepEqual(parseHandlerSpec(undefined, "mail/send-digest.md", "anywhere"), {
            topic: "mail",
            handler: "send-digest",
        });
    });

    it("strips .MD (case-insensitive)", () => {
        assert.deepEqual(parseHandlerSpec(undefined, "send.MD", "mail"), {
            topic: "mail",
            handler: "send",
        });
    });

    it("does not strip .md when it is not a suffix", () => {
        assert.deepEqual(parseHandlerSpec(undefined, "send.markdown", "mail"), {
            topic: "mail",
            handler: "send.markdown",
        });
    });

    it("empty handler basename (`mail/`) → BadHandler", () => {
        assert.throws(
            () => parseHandlerSpec(undefined, "mail/", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadHandler");
                return true;
            },
        );
    });

    it("empty handler string → BadHandler", () => {
        assert.throws(
            () => parseHandlerSpec(undefined, "", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadHandler");
                return true;
            },
        );
    });

    it("leading slash with no explicit topic (`/index`) → BadHandler", () => {
        assert.throws(
            () => parseHandlerSpec(undefined, "/index", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadHandler");
                return true;
            },
        );
    });

    it("doubled slash (`mail//send`) → BadHandler", () => {
        assert.throws(
            () => parseHandlerSpec(undefined, "mail//send", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadHandler");
                return true;
            },
        );
    });

    it("derived topic with illegal characters → BadTopic", () => {
        assert.throws(
            () => parseHandlerSpec(undefined, "mail!/send", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadTopic");
                return true;
            },
        );
    });

    it("explicit topic with illegal characters → BadTopic", () => {
        assert.throws(
            () => parseHandlerSpec("bad topic", "send", "anywhere"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadTopic");
                return true;
            },
        );
    });

    it("fallback topic with illegal characters → BadTopic", () => {
        assert.throws(
            () => parseHandlerSpec(undefined, "send", "bad topic"),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadTopic");
                return true;
            },
        );
    });
});
