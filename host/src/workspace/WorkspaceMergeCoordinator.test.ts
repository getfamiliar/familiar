import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    DuplicateIdempotencyKeyError,
    type EmitHandle,
    type Logger,
    type NewBanner,
    type NewEvent,
} from "@getfamiliar/shared";
import {
    WORKSPACE_APPLY_NOTE_TOPIC,
    WorkspaceMergeCoordinator,
} from "./WorkspaceMergeCoordinator.js";
import { WorkspaceUpdater } from "./WorkspaceUpdater.js";

const silentLog = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => silentLog,
} as unknown as Logger;

let root: string;
let workspaceDir: string;
let templateDir: string;
let updatesDir: string;
let updater: WorkspaceUpdater;
let banners: NewBanner[];
let emitted: NewEvent[];

/**
 * Write a file, creating parent folders.
 *
 * @param file Absolute path.
 * @param content Content.
 */
function put(file: string, content: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
}

/**
 * A settled emit handle.
 *
 * @param result The agent's answer, or an error to reject with.
 * @returns The handle.
 */
function handle(result: string | Error): EmitHandle {
    return {
        id: String(emitted.length),
        settled: result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    };
}

/**
 * Coordinator over the test workspace with a scripted agent.
 *
 * @param agent Answers one event (may settle the item through the updater).
 * @returns The coordinator.
 */
function coordinator(agent: (event: NewEvent) => Promise<EmitHandle>): WorkspaceMergeCoordinator {
    return new WorkspaceMergeCoordinator({
        report: {
            ...updater.status(),
            applied: [],
            snapshotCommit: null,
            updateCommit: null,
            gitError: null,
        },
        updater,
        emit: async (event) => {
            emitted.push(event);
            return agent(event);
        },
        banners: { create: async (banner: NewBanner) => banners.push(banner) },
        workspaceDir,
        git: null,
        timezone: "Europe/Berlin",
        version: "1.1.0",
        log: silentLog,
    });
}

beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "merge-coordinator-"));
    workspaceDir = path.join(root, "workspace");
    templateDir = path.join(root, "template");
    updatesDir = path.join(root, "updates");
    banners = [];
    emitted = [];
    mkdirSync(workspaceDir, { recursive: true });
    for (const name of ["a", "b", "c"]) {
        put(path.join(templateDir, `${name}.md`), "template\n");
        put(path.join(workspaceDir, `${name}.md`), `mine ${name}\n`);
    }
    updater = new WorkspaceUpdater({
        workspaceDir,
        baseDir: path.join(root, "base"),
        sources: () => [{ id: "core", templateDir, updatesDir }],
        git: null,
    });
    await updater.sync("1.0.0");
    put(path.join(updatesDir, "2026-11-07-demo.md"), "do something\n");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceMergeCoordinator", () => {
    it("runs notes first, one event per item, then reports and creates banners", async () => {
        await coordinator(async (event) => {
            if (event.topic === WORKSPACE_APPLY_NOTE_TOPIC) {
                await updater.markNoteDone("core/2026-11-07-demo", "done");
                return handle("decided: note core/2026-11-07-demo — nothing to do");
            }
            if (event.prompt === "path: a.md") {
                await updater.resolve("a.md", "accept_live", "keep");
                return handle("decided: a.md — accept_live — kept");
            }
            if (event.prompt === "path: b.md") {
                return handle("question: b.md — keep the old greeting? — recommended: yes");
            }
            return handle(new Error("model unavailable"));
        }).run();

        assert.deepEqual(
            emitted.map((event) => [
                event.topic,
                event.prompt,
                event.privileged,
                event.isExactTopic,
            ]),
            [
                ["update:apply-note", "id: core/2026-11-07-demo", true, true],
                ["update:merge-file", "path: a.md", true, true],
                ["update:merge-file", "path: b.md", true, true],
                ["update:merge-file", "path: c.md", true, true],
            ],
        );
        const [reportName] = readdirSync(path.join(workspaceDir, "files", "updates"));
        const report = readFileSync(
            path.join(workspaceDir, "files", "updates", reportName),
            "utf8",
        );
        assert.match(
            report,
            /## Decided by the assistant\n\n- decided: note core\/2026-11-07-demo/,
        );
        assert.match(report, /- decided: a\.md — accept_live — kept/);
        assert.match(report, /- b\.md: question: b\.md — keep the old greeting\?/);
        assert.match(report, /- c\.md: failed: model unavailable/);
        assert.equal(banners.length, 2);
        assert.match(banners[0].text, /2 workspace file\(s\) or note\(s\)/);
        assert.match(banners[1].text, /2 decision\(s\) need the user/);
    });

    it("skips items an earlier start already handed over, without a new report or banner", async () => {
        await coordinator(async () => {
            throw new DuplicateIdempotencyKeyError("dup");
        }).run();
        assert.equal(emitted.length, 4);
        assert.equal(banners.length, 0);
        assert.equal(existsSync(path.join(workspaceDir, "files", "updates")), false);
    });

    it("stops before the next item when the daemon stops", async () => {
        const run = coordinator(async (event) => {
            run.stop();
            return handle(`question: ${event.prompt}`);
        });
        await run.run();
        assert.equal(emitted.length, 1);
    });
});
