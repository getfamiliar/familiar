import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { EVENT_PRIORITY, type HostContext } from "@getfamiliar/shared";
import type { MailboxTarget } from "./MailboxMap.js";
import {
    type MailStyleTemplate,
    mailStyleTemplatePath,
    signatureToPlainText,
} from "./MailStyleTemplate.js";
import { type DebugSink, type SentExample, SentSampler } from "./SentSampler.js";
import { extractAnchor } from "./SignatureAnchor.js";

/** Topic / handler routing for both extraction events. */
const EXTRACTION_TOPIC = "mail:tools";
const EXTRACTION_HANDLER = "extract-formatting";

/** Mode label embedded in the prompt and event payload. */
type ExtractionMode = "signature" | "textStyle";

/** Dependencies the extractor needs at construction time. */
export interface TemplateExtractorDeps {
    /**
     * Host context. Used for `ctx.events.emit` (to spawn the
     * extraction agentruns and await their `result_text`), for
     * `ctx.dataDir` (to resolve where templates land on disk), and
     * for `ctx.log`.
     */
    readonly ctx: HostContext;
    /** Mailbox set the daemon already resolved at start. */
    readonly mailboxMap: readonly MailboxTarget[];
    /** Per-kind sample count read from config. */
    readonly exampleCount: number;
    /**
     * Optional verbose-debug write sink. When set, every Sent message
     * the sampler scans is dumped through it before classification.
     * Wired by the `-v` flag on the `extract-formatting` CLI; daemon-
     * driven extraction leaves it undefined.
     */
    readonly debug?: DebugSink;
}

/**
 * Per-mailbox style-template orchestrator. One instance for the whole
 * daemon; serialises extraction work across mailboxes so the single-
 * slot agentrun scheduler isn't crowded out by a burst of background
 * events at boot or 4am.
 *
 * Two public entry points:
 *
 *  - `refreshMissingTemplates()` — boot pass: extract only the
 *    mailboxes whose template file is absent.
 *  - `refreshAll()` — cron pass: extract every mailbox unconditionally.
 *
 * Both delegate to `extractOne(target)` which does one sample + two
 * extraction events + the deterministic-flag computation, then writes
 * the per-mailbox JSON atomically.
 */
export class TemplateExtractor {
    private readonly deps: TemplateExtractorDeps;

    constructor(deps: TemplateExtractorDeps) {
        this.deps = deps;
    }

    /**
     * Boot pass. Walks the mailbox map and extracts only the entries
     * whose JSON template file is absent. Cheap on a normal restart:
     * when every file is on disk this iterates and emits zero events.
     */
    async refreshMissingTemplates(): Promise<void> {
        for (const target of this.deps.mailboxMap) {
            const file = mailStyleTemplatePath(this.deps.ctx.dataDir, target.mailbox);
            if (existsSync(file)) {
                continue;
            }
            await this.runOne(target);
        }
    }

    /**
     * Cron pass. Walks the mailbox map and extracts every entry,
     * overwriting existing files. Errors on individual mailboxes are
     * logged and skipped — one bad mailbox doesn't poison the refresh
     * for the others.
     */
    async refreshAll(): Promise<void> {
        for (const target of this.deps.mailboxMap) {
            await this.runOne(target);
        }
    }

    /**
     * One sample + two-event + deterministic-flag + persist cycle.
     * Wraps {@link extractOne} with the per-mailbox error boundary so
     * a thrown Graph error or agentrun failure for one mailbox doesn't
     * tear down the whole refresh.
     */
    private async runOne(target: MailboxTarget): Promise<void> {
        try {
            await this.extractOne(target);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.deps.ctx.log(
                `ms365 template-extract ${target.mailbox}: ${message} — keeping existing file`,
            );
        }
    }

    /**
     * Sample the Sent folder once, run two extraction events
     * (signature, textStyle), compute the deterministic booleans, and
     * persist the JSON atomically. Throws on Graph / agentrun / I/O
     * failure so {@link runOne}'s error boundary can log and move on.
     *
     * Defensive policy: if either model event returns nothing usable,
     * we *don't* write a partial template — the existing file (if any)
     * is left untouched. Same rule the old marker-validation path used.
     */
    private async extractOne(target: MailboxTarget): Promise<void> {
        const sampler = new SentSampler(target, this.deps.debug);
        const { buckets, summary } = await sampler.sample({ perKind: this.deps.exampleCount });
        this.deps.ctx.log(
            `ms365 template-extract ${target.mailbox}: scanned ${summary.scanned}, kept ${summary.kept} ` +
                `(reply ${buckets.reply.length}, forward ${buckets.forward.length}, new ${buckets.new.length}); ` +
                `dropped: meeting ${summary.droppedAsMeeting}, ` +
                `oversize ${summary.droppedAsOversize}, ` +
                `bucket-full ${summary.droppedAsBucketFull}, ` +
                `empty-after-strip ${summary.droppedAsEmptyAfterStrip}`,
        );
        const allExamples = [...buckets.reply, ...buckets.forward, ...buckets.new];
        if (allExamples.length === 0) {
            this.deps.ctx.log(
                `ms365 template-extract ${target.mailbox}: no usable examples in Sent — skipping`,
            );
            return;
        }

        // Signature: drawn from `new` mails when available — that bucket
        // carries the cleanest signature data. Fall back to all examples
        // for a brand-new mailbox where the user hasn't sent original
        // mail recently but has been replying.
        const signatureExamples = buckets.new.length > 0 ? buckets.new : allExamples;
        const signature = await this.runExtraction(target, "signature", signatureExamples);
        if (signature === null) {
            return;
        }
        const textStyle = await this.runExtraction(target, "textStyle", allExamples);
        if (textStyle === null) {
            return;
        }

        const usePlainText = decideUsePlainText(allExamples);
        const anchor = extractAnchor(signature);
        const useSignatureOnReplies =
            anchor === null ? false : majorityContainsAnchor(buckets.reply, anchor);
        const useSignatureOnForwards =
            anchor === null ? false : majorityContainsAnchor(buckets.forward, anchor);

        const template: MailStyleTemplate = {
            signature,
            textStyle,
            usePlainText,
            useSignatureOnReplies,
            useSignatureOnForwards,
        };
        await persistTemplate(this.deps.ctx.dataDir, target.mailbox, template);
        this.deps.ctx.log(
            `ms365 template-extract ${target.mailbox}: wrote template (signature ${Buffer.byteLength(signature, "utf8")}B, textStyle "${textStyle}", plainText=${usePlainText}, sigOnReplies=${useSignatureOnReplies}, sigOnForwards=${useSignatureOnForwards})`,
        );
    }

    /**
     * Emit one extraction event in either mode, await the agentrun,
     * defensively strip a markdown fence, and return the cleaned
     * string. Returns `null` (and logs) when the model output was
     * empty after cleaning — caller treats that as "skip the
     * persist, keep the existing file".
     */
    private async runExtraction(
        target: MailboxTarget,
        mode: ExtractionMode,
        examples: readonly SentExample[],
    ): Promise<string | null> {
        const prompt = buildPrompt(mode, examples);
        const handle = await this.deps.ctx.events.emit({
            topic: EXTRACTION_TOPIC,
            startHandler: EXTRACTION_HANDLER,
            prompt,
            payload: {
                mailbox: target.mailbox,
                mode,
                exampleCount: examples.length,
            },
            idempotencyKey: `ms365:extract-formatting:${target.mailbox}:${mode}:${Date.now()}`,
            priority: EVENT_PRIORITY.BACKGROUND,
            privileged: false,
        });
        const resultText = await handle.settled;
        const cleaned = stripMarkdownFence(resultText).trim();
        if (cleaned.length === 0) {
            this.deps.ctx.log(
                `ms365 template-extract ${target.mailbox} (${mode}): empty result — keeping existing file`,
            );
            return null;
        }
        return cleaned;
    }
}

/**
 * Render the prompt for one of the two extraction modes. The handler
 * markdown (`workspace-template/mail/tools/extract-formatting.md`)
 * carries the per-mode instructions — the prompt only has to declare
 * the mode and deliver the examples.
 */
function buildPrompt(mode: ExtractionMode, examples: readonly SentExample[]): string {
    const header =
        mode === "signature"
            ? "Extract the SIGNATURE.\n\nHere are the examples:"
            : "Extract the DEFAULT TEXT STYLE.\n\nHere are the examples:";
    const body = examples
        .map((ex, idx) => `### Example ${idx + 1}\n\`\`\`\n${ex.innerHtml}\n\`\`\``)
        .join("\n\n");
    return `${header}\n\n${body}\n`;
}

/**
 * Decide `usePlainText` deterministically from the sample. Walks each
 * example's `contentType` and picks the dominant value. Ties (or no
 * data) resolve to `false` because HTML is the safer default — the
 * send path can always degrade an HTML body when the recipient
 * displays plain text, but the reverse needs format-aware fallback.
 */
function decideUsePlainText(examples: readonly SentExample[]): boolean {
    let text = 0;
    let html = 0;
    for (const ex of examples) {
        if (ex.contentType === "text") {
            text += 1;
        } else {
            html += 1;
        }
    }
    return text > html;
}

/**
 * True when `anchor` appears (case-insensitively) in ≥ half of the
 * examples' stripped inner HTML. Empty bucket ⇒ `false` (no evidence;
 * default to "don't sign").
 */
function majorityContainsAnchor(examples: readonly SentExample[], anchor: string): boolean {
    if (examples.length === 0) {
        return false;
    }
    const needle = anchor.toLowerCase();
    let hits = 0;
    for (const ex of examples) {
        if (ex.innerHtml.toLowerCase().includes(needle)) {
            hits += 1;
        }
    }
    return hits * 2 >= examples.length;
}

/**
 * Strip a single leading/trailing ```html ... ``` (or ```css …```)
 * fence if the model wrapped its output despite the prompt's
 * instruction. Idiom: if the input begins with a fenced block and the
 * closing fence sits at the very end, return the inside.
 */
function stripMarkdownFence(raw: string): string {
    const trimmed = raw.trim();
    const fenceRe = /^```(?:[a-z]+)?\s*\n([\s\S]*?)\n```\s*$/i;
    const match = fenceRe.exec(trimmed);
    return match ? match[1] : trimmed;
}

/**
 * Atomic write: mkdir the parent, write to a `.tmp` neighbour, then
 * rename onto the target path. Means a torn write never produces a
 * half-baked template file the send path would happily apply.
 */
async function persistTemplate(
    dataDir: string,
    mailbox: string,
    template: MailStyleTemplate,
): Promise<void> {
    const target = mailStyleTemplatePath(dataDir, mailbox);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(template, null, 2)}\n`, "utf8");
    await rename(tmp, target);
}

// Re-exported for tests that want to exercise the helpers without
// going through Graph.
export const __test = {
    decideUsePlainText,
    majorityContainsAnchor,
    stripMarkdownFence,
    buildPrompt,
    signatureToPlainText,
};
