import type * as React from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    CodeBlock,
    CodeBlockActions,
    CodeBlockContent,
    CodeBlockCopyButton,
    CodeBlockHeader,
    CodeBlockLine,
    CodeBlockTitle,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";

/**
 * A message rendered as GitHub-flavored markdown with shadcn typeset
 * styles; fenced code becomes a highlighted code block with a copy
 * button (from the chatbot template's text part).
 *
 * @param props.text Markdown source.
 * @returns The rendered markdown.
 */
export function Markdown({ text }: { readonly text: string }) {
    return (
        <div className="typeset typeset-docs">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    pre: MarkdownPre,
                    a: ({ node: _node, ...props }) => (
                        <a {...props} target="_blank" rel="noreferrer noopener" />
                    ),
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}

/**
 * Fenced code arrives as `<pre><code>`: read language and text from the
 * hast node and render a code block.
 *
 * @param props `pre` props with the hast node.
 * @returns The code block, or a plain `pre`.
 */
function MarkdownPre({ node, children, ...props }: React.ComponentProps<"pre"> & ExtraProps) {
    const element = node?.children[0];
    if (element?.type !== "element" || element.tagName !== "code") {
        return <pre {...props}>{children}</pre>;
    }
    const language =
        /language-([^\s,]+)/.exec(String(element.properties.className ?? ""))?.[1] ?? "";
    const code = element.children
        .map((child) => (child.type === "text" ? child.value : ""))
        .join("")
        .replace(/\n$/, "");
    return <MarkdownCodeBlock code={code} language={language} />;
}

/**
 * Highlighted code block.
 *
 * @param props.code Source text.
 * @param props.language Fence language (may be empty).
 * @returns The block.
 */
function MarkdownCodeBlock({
    code,
    language,
}: {
    readonly code: string;
    readonly language: string;
}) {
    const lines = useHighlightedCode(code, language);
    return (
        <CodeBlock className="not-typeset mt-(--typeset-flow)">
            <CodeBlockHeader>
                <CodeBlockTitle>{language || "text"}</CodeBlockTitle>
                <CodeBlockActions>
                    <CodeBlockCopyButton value={code} />
                </CodeBlockActions>
            </CodeBlockHeader>
            <CodeBlockContent>
                {lines.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity besides their position
                    <CodeBlockLine key={index}>{line}</CodeBlockLine>
                ))}
            </CodeBlockContent>
        </CodeBlock>
    );
}
