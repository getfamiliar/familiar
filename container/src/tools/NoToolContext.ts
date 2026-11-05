/**
 * Tool-context type for built-in tools that declare no `contextSchema`.
 *
 * AI SDK 7 added a third `CONTEXT` generic to `tool()` / `Tool`, and the
 * two-argument form `tool<INPUT, X>` now binds `X` to `CONTEXT` instead of
 * `OUTPUT`. Our tools receive everything through closures and never read the
 * SDK's per-tool `context`, so they spell it out as
 * `tool<INPUT, OUTPUT, NoToolContext>`.
 */
export type NoToolContext = Record<string, never>;
