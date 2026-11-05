import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { firstMenuRoute } from "@getfamiliar/shared";
import { WebMenuRegistry } from "./WebMenuRegistry.js";

describe("WebMenuRegistry", () => {
    it("sorts by plugin weight, then plugin id, keeping each plugin's item order", () => {
        const registry = new WebMenuRegistry();
        registry.set("mail", {
            weight: 10,
            items: [
                { icon: "mail", label: "Inbox", route: "/plugins/mail" },
                { icon: "send", label: "Sent", route: "/plugins/mail/sent" },
            ],
        });
        registry.set("chat", {
            items: [{ icon: "message-circle", label: "Chat", route: "/chat" }],
        });
        registry.set("agenda", {
            items: [{ icon: "calendar-days", label: "Agenda", route: "/agenda" }],
        });
        assert.deepEqual(
            registry.list().map((entry) => `${entry.pluginId}:${entry.label}`),
            ["agenda:Agenda", "chat:Chat", "mail:Inbox", "mail:Sent"],
        );
        registry.unregisterPlugin("agenda");
        assert.equal(registry.list()[0]?.label, "Chat");
    });

    it("rejects malformed items and keeps the previous state", () => {
        const registry = new WebMenuRegistry();
        const cases: [unknown, RegExp][] = [
            [{ icon: "Mail", label: "x", route: "/x" }, /not a lucide icon id/],
            [{ icon: "mail", label: " ", route: "/x" }, /label must not be empty/],
            [{ icon: "mail", label: "x", route: "https://evil" }, /must be a path starting with/],
            [{ icon: "mail", label: "x", route: "//evil" }, /must be a path starting with/],
            [{ icon: "mail", label: "x" }, /needs a route or children/],
            [{ icon: "mail", label: "x", children: [{ label: "", route: "/a" }] }, /empty label/],
        ];
        for (const [item, pattern] of cases) {
            assert.throws(
                () => registry.set("bad", { items: [item as never] }),
                (err: Error) => pattern.test(err.message) && err.message.includes('plugin "bad"'),
            );
        }
        assert.throws(() => registry.set("bad", { weight: Number.NaN, items: [] }), /weight/);
        assert.deepEqual(registry.list(), []);
    });

    it("finds the first route: the item's own, else its first child's", () => {
        assert.equal(firstMenuRoute([]), null);
        assert.equal(
            firstMenuRoute([{ icon: "a", label: "A", children: [{ label: "B", route: "/b" }] }]),
            "/b",
        );
        assert.equal(
            firstMenuRoute([
                { icon: "a", label: "A", route: "/a", children: [{ label: "B", route: "/b" }] },
            ]),
            "/a",
        );
    });
});
