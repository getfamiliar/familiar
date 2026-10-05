import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { type Chunk, chunkMarkdown, splitOversizedChunk } from "./MarkdownChunker.js";

const MAX = 1000;

/** Length of the embedding input `MemoryStore.buildEmbeddingInput` builds. */
function embeddingInputLength(chunk: Chunk): number {
    return [chunk.headlines, chunk.context, chunk.content].filter((p) => p.length > 0).join("\n\n")
        .length;
}

/** `count` list items of roughly `size` characters, numbered for tracing. */
function listItems(count: number, size: number): string[] {
    return Array.from({ length: count }, (_, i) =>
        `- **Item ${i}**: ${"lorem ipsum ".repeat(Math.ceil(size / 12))}`.slice(0, size).trimEnd(),
    );
}

describe("chunkMarkdown size limit", () => {
    it("keeps a section under the limit as one unchanged chunk", () => {
        const chunks = chunkMarkdown("# Doc\n\nIntro.\n\n## Small\n\nShort body.\n", "doc.md", MAX);
        assert.deepEqual(chunks, [
            { headlines: "# Doc", context: "Intro.", content: "Intro." },
            { headlines: "# Doc > ## Small", context: "Intro.", content: "Short body." },
        ]);
    });

    it("splits an oversized list section at item boundaries", () => {
        const items = listItems(30, 200);
        const source = `# Doc\n\n## Forge Migration\n\n${items.join("\n")}\n`;
        const chunks = chunkMarkdown(source, "doc.md", MAX);

        assert.ok(chunks.length > 1);
        for (const [i, chunk] of chunks.entries()) {
            assert.ok(
                embeddingInputLength(chunk) <= MAX,
                `part ${i} is ${embeddingInputLength(chunk)} chars`,
            );
            assert.equal(
                chunk.headlines,
                `# Doc > ## Forge Migration (part ${i + 1}/${chunks.length})`,
            );
            assert.match(
                chunk.content,
                /^- \*\*Item \d+\*\*/,
                "each part starts with a whole list item",
            );
        }
        const reassembled = chunks.map((c) => c.content).join("\n");
        for (const item of items) {
            assert.equal(
                reassembled.split(item).length - 1,
                1,
                `${item.slice(0, 20)} appears exactly once`,
            );
        }
    });

    it("hard-splits a single giant paragraph", () => {
        const paragraph = "This is a sentence about Forge. ".repeat(200);
        const chunks = chunkMarkdown(`# Doc\n\n## Giant\n\n${paragraph}`, "doc.md", MAX);
        assert.ok(chunks.length > 1);
        for (const chunk of chunks) {
            assert.ok(embeddingInputLength(chunk) <= MAX);
        }
        assert.equal(
            chunks
                .map((c) => c.content)
                .join(" ")
                .replace(/\s+/g, " "),
            paragraph.trim().replace(/\s+/g, " "),
        );
    });

    it("subtracts a long context from the budget", () => {
        const chunk: Chunk = {
            headlines: "# Doc > ## Section",
            context: "c".repeat(400),
            content: listItems(10, 150).join("\n"),
        };
        const parts = splitOversizedChunk(chunk, MAX);
        assert.ok(parts.length > 1);
        for (const part of parts) {
            assert.equal(part.context, chunk.context);
            assert.ok(embeddingInputLength(part) <= MAX);
        }
    });

    it("never splits inside a fenced code block that fits", () => {
        const fence = `\`\`\`sh\n${"echo line\n\n".repeat(30)}\`\`\``;
        const source = `# Doc\n\n## Code\n\n${listItems(4, 200).join("\n")}\n\n${fence}\n`;
        const chunks = chunkMarkdown(source, "doc.md", MAX);
        assert.ok(
            chunks.some((c) => c.content.includes(fence)),
            "the fence survives intact in one part",
        );
    });
});
