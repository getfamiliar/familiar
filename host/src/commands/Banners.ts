import { BannerBus, formatBannerTime, markdownTable, writeMarkdown } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";
import { PostgresContainer } from "../db/PostgresContainer.js";
import { HostConfigService } from "../utils/ConfigService.js";

const RAW_ARG = {
    type: "boolean",
    description: "Skip terminal styling and emit the raw markdown verbatim.",
    default: false,
} as const;

/**
 * Run `fn` with a banner bus on the running daemon's postgres and close
 * the connection afterwards.
 *
 * @param fn Work to do; receives the bus and the user's timezone.
 * @returns What `fn` returns.
 * @throws {Error} When postgres is not reachable (daemon not running).
 */
async function withBannerBus<T>(fn: (bus: BannerBus, timezone: string) => Promise<T>): Promise<T> {
    const boot = bootstrap();
    const config = new HostConfigService(boot.configFile);
    const postgres = new PostgresContainer({
        dataPath: boot.dataDir,
        portFilePath: boot.postgresPortFile,
        password: config.getString("core.postgresPassword"),
    });
    const timezone = config.getString(
        "core.timezone",
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    const connection = postgres.getConnection();
    try {
        return await fn(new BannerBus(connection), timezone);
    } finally {
        await connection.close();
    }
}

/** `familiar banners list` — the banners every agentrun currently sees. */
const listCommand = defineCommand({
    meta: {
        name: "list",
        description: "List the active banners the agent sees in every prompt.",
    },
    args: { raw: RAW_ARG },
    async run({ args }) {
        await withBannerBus(async (bus, timezone) => {
            const banners = await bus.listActive();
            if (banners.length === 0) {
                writeMarkdown("No active banners.", { raw: args.raw });
                return;
            }
            writeMarkdown(
                markdownTable(
                    ["Id", "Created", "Expires", "Created by", "Text"],
                    banners.map((banner) => [
                        banner.id,
                        formatBannerTime(banner.createdAt, timezone),
                        formatBannerTime(banner.expiresAt, timezone),
                        banner.createdByTopic === null
                            ? ""
                            : `${banner.createdByTopic} (agentrun ${banner.createdByAgentrunId ?? "deleted"})`,
                        banner.text,
                    ]),
                ),
                { raw: args.raw },
            );
        });
    },
});

/** `familiar banners remove <id>…` — delete banners before they expire. */
const removeCommand = defineCommand({
    meta: {
        name: "remove",
        description: "Remove one or more banners by id (see `familiar banners list`).",
    },
    args: {
        ids: {
            type: "positional",
            required: true,
            description: "Banner id(s), comma- or space-separated.",
        },
        raw: RAW_ARG,
    },
    async run({ args }) {
        const ids = [String(args.ids), ...args._]
            .flatMap((part) => String(part).split(/[\s,]+/))
            .filter((part) => part.length > 0);
        const malformed = ids.filter((id) => !/^\d+$/.test(id));
        if (malformed.length > 0) {
            throw new Error(`banner ids must be numbers, got: ${malformed.join(", ")}`);
        }
        await withBannerBus(async (bus) => {
            const unique = [...new Set(ids)];
            const removed = await bus.remove(unique);
            const notFound = unique.filter((id) => !removed.includes(id));
            const lines = [
                `Removed ${removed.length} banner${removed.length === 1 ? "" : "s"}${removed.length > 0 ? ` (${removed.join(", ")})` : ""}.`,
            ];
            if (notFound.length > 0) {
                lines.push("", `No active banner with id ${notFound.join(", ")}.`);
            }
            writeMarkdown(lines.join("\n"), { raw: args.raw });
        });
    },
});

/** `familiar banners` — inspect and remove the agent's short-lived banners. Needs the running daemon (postgres). */
export const bannersCommand = defineCommand({
    meta: {
        name: "banners",
        description: "Short-lived notes the agent sees in every prompt: list or remove them.",
    },
    subCommands: {
        list: listCommand,
        remove: removeCommand,
    },
});
