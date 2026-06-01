import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { Logger } from "@getfamiliar/shared";
import { PluginToolsClient } from "./ToolsClient.js";

/**
 * A minimal catalog entry as the bastion's `GET /plugin-tools/`
 * serves it. The four host-owned tools carry the reserved `core`
 * sentinel `pluginId`; `whatsapp_mark_read` is a real plugin tool.
 */
const CATALOG = [
    {
        key: "cal_get_events",
        pluginId: "core",
        description: "list events",
        inputSchema: { type: "object" },
        groups: ["cal"],
    },
    {
        key: "mail_search",
        pluginId: "core",
        description: "search mail",
        inputSchema: { type: "object" },
        groups: ["mail"],
    },
    {
        key: "agentrun_report",
        pluginId: "core",
        description: "report",
        inputSchema: { type: "object" },
        groups: ["reflection"],
    },
    {
        key: "whatsapp_mark_read",
        pluginId: "whatsapp",
        description: "mark read",
        inputSchema: { type: "object" },
        groups: [],
    },
];

const NOOP_LOG: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
} as unknown as Logger;

describe("PluginToolsClient — core sentinel is not an addressable auto-group", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it("omits a `core` auto-group but keeps real plugin ids and declared groups", async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify(CATALOG), {
                status: 200,
                headers: { "content-type": "application/json" },
            })) as typeof fetch;

        const client = new PluginToolsClient({ bastionUrl: "http://bastion", log: NOOP_LOG });
        const { tools, keysById, groupKeys } = await client.tools("evt-1", "run-1", 10_000);

        // Every catalog tool still surfaces in the tool set.
        assert.deepEqual(Object.keys(tools).sort(), [
            "agentrun_report",
            "cal_get_events",
            "mail_search",
            "whatsapp_mark_read",
        ]);

        // The `core` sentinel must NOT form a plugin-id auto-group — it
        // would shadow the curated `core` group in the evaluator. Real
        // plugin ids (`whatsapp`) still get their auto-group.
        assert.equal(keysById.has("core"), false);
        assert.deepEqual([...(keysById.get("whatsapp") ?? [])], ["whatsapp_mark_read"]);

        // Declared `groups` still flow through for host-owned tools, so
        // they stay addressable by name (`tools: core + cal`).
        assert.deepEqual([...(groupKeys.get("cal") ?? [])], ["cal_get_events"]);
        assert.deepEqual([...(groupKeys.get("mail") ?? [])], ["mail_search"]);
        assert.deepEqual([...(groupKeys.get("reflection") ?? [])], ["agentrun_report"]);
    });
});
