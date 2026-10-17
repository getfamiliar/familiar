import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ToolError } from "@getfamiliar/shared";
import { parseHandlerTopic } from "./HandlerSpecParser.js";

describe("parseHandlerTopic", () => {
    it("returns a colon topic unchanged", () => {
        assert.equal(parseHandlerTopic("skills:memory:save"), "skills:memory:save");
    });

    it("accepts hyphenated segments", () => {
        assert.equal(parseHandlerTopic("mail:extract-style"), "mail:extract-style");
    });

    it("converts a slash path into a colon topic", () => {
        assert.equal(parseHandlerTopic("mail/whatsapp/send"), "mail:whatsapp:send");
    });

    it("strips a leading slash and a trailing .md", () => {
        assert.equal(parseHandlerTopic("/skills/memory/save.MD"), "skills:memory:save");
    });

    it("maps the folder form x/index.md onto topic x", () => {
        assert.equal(parseHandlerTopic("chat/telegram/index.md"), "chat:telegram");
        assert.equal(parseHandlerTopic("chat/index"), "chat");
    });

    it("trims surrounding whitespace", () => {
        assert.equal(parseHandlerTopic("  chat:cli  "), "chat:cli");
    });

    for (const bad of ["", "mail//send", "mail/", "mail::send", "mail send", "mail.md"]) {
        it(`rejects ${JSON.stringify(bad)} with BadTopic`, () => {
            assert.throws(
                () => parseHandlerTopic(bad),
                (err: unknown) => err instanceof ToolError && err.code === "BadTopic",
            );
        });
    }
});
