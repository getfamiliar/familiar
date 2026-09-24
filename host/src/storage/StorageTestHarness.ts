import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageError } from "@getfamiliar/shared";
import {
    type FakeStorageOptions,
    FakeStorageProvider,
    MockLogger,
} from "@getfamiliar/shared/testing";
import { parseStorageSettings } from "./StorageConfig.js";
import { StorageRegistry } from "./StorageRegistry.js";
import { StorageService } from "./StorageService.js";

/** Test fixture: a service over one fake provider with mutable raw config. */
export interface StorageHarness {
    readonly service: StorageService;
    readonly fake: FakeStorageProvider;
    readonly registry: StorageRegistry;
    /** Raw `storage` config group; mutate to change policy mid-test. */
    raw: Record<string, unknown>;
    readonly scratchDir: string;
    readonly eventId: string;
    readonly ctx: { readonly eventId: string; readonly agentrunId: string };
}

/**
 * Build a {@link StorageService} over a {@link FakeStorageProvider}
 * (plugin id `fake`, account `a@x`). Test-only.
 *
 * @param raw - Raw `storage` config group.
 * @param fakeOptions - Fake provider knobs.
 */
export async function makeStorageHarness(
    raw: Record<string, unknown>,
    fakeOptions: FakeStorageOptions = {},
): Promise<StorageHarness> {
    const base = await mkdtemp(path.join(tmpdir(), "storage-test-"));
    const scratchDir = path.join(base, "scratch");
    const eventId = "evt-1";
    await mkdir(path.join(scratchDir, eventId), { recursive: true });
    const registry = new StorageRegistry();
    const fake = new FakeStorageProvider(fakeOptions);
    registry.registerProvider(fake);
    const harness: StorageHarness = {
        raw,
        fake,
        registry,
        scratchDir,
        eventId,
        ctx: { eventId, agentrunId: "run-1" },
        service: undefined as unknown as StorageService,
    };
    const service = new StorageService({
        registry,
        settings: () => parseStorageSettings(harness.raw),
        scratchDir,
        stagingDir: path.join(base, "staging"),
        log: new MockLogger(),
    });
    return Object.assign(harness, { service });
}

/** `assert.rejects` matcher for a ToolError / StorageError code. */
export function hasCode(code: string): (err: unknown) => boolean {
    return (err) =>
        (err instanceof Error && "code" in err && (err as { code: unknown }).code === code) ||
        (err instanceof StorageError && err.code === code);
}
