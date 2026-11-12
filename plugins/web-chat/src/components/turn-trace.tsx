import * as React from "react";
import { StatusIcon, type TraceStatus } from "@/components/status-icon";
import {
    Trace,
    TraceCollapsible,
    TraceCollapsibleContent,
    TraceCollapsibleTrigger,
    TraceDescription,
    TraceIcon,
    TraceLine,
    TraceTitle,
} from "@/components/ui/trace";
import type { ChatRunDto, ChatStepDto, ChatToolCallDto, ChatTurnDto } from "@/host/ChatProtocol";

/**
 * Progress of one turn, the web counterpart of cli-chat's spinner lines:
 * one line per agentrun (topic, model, state) with its steps below —
 * reasoning (collapsible), intermediate text and every tool call with its
 * arguments and result. Open while the turn runs; afterwards collapsed
 * into a one-line summary the user can expand.
 *
 * @param props.turn The turn.
 * @returns The trace, or nothing before the first agentrun.
 */
export function TurnTrace({ turn }: { readonly turn: ChatTurnDto }) {
    const isRunning = turn.state === "running";
    const [isOpen, setIsOpen] = React.useState<boolean>();
    const toolCount = turn.steps.reduce((sum, step) => sum + step.tools.length, 0);

    if (turn.runs.length === 0) {
        return isRunning ? (
            <Trace>
                <TraceLine status="running">
                    <TraceIcon>
                        <StatusIcon status="running" />
                    </TraceIcon>
                    <TraceTitle>Waiting for the assistant</TraceTitle>
                </TraceLine>
            </Trace>
        ) : null;
    }

    const details = (
        <div className="flex flex-col gap-2">
            {turn.runs.map((run) => (
                <RunTrace
                    key={run.id}
                    run={run}
                    steps={turn.steps.filter((step) => step.agentRunId === run.id)}
                />
            ))}
        </div>
    );
    const summaryStatus: TraceStatus = isRunning
        ? "running"
        : turn.state === "failed"
          ? "error"
          : "done";
    const latestSaid = isRunning ? findLatestSaid(turn.steps) : null;
    const summary = isRunning
        ? (latestSaid ?? "Working")
        : turn.state === "failed"
          ? `Failed: ${turn.error ?? "unknown error"}`
          : `Done in ${turn.steps.length} ${turn.steps.length === 1 ? "step" : "steps"}${toolCount > 0 ? `, ${toolCount} ${toolCount === 1 ? "tool call" : "tool calls"}` : ""}`;

    return (
        <Trace>
            <TraceCollapsible open={isOpen ?? isRunning} onOpenChange={setIsOpen}>
                <TraceCollapsibleTrigger>
                    <TraceLine
                        status={
                            summaryStatus === "done"
                                ? undefined
                                : summaryStatus === "error"
                                  ? "error"
                                  : "running"
                        }
                    >
                        <TraceIcon>
                            <StatusIcon status={summaryStatus} />
                        </TraceIcon>
                        <TraceTitle title={latestSaid ?? undefined}>{summary}</TraceTitle>
                    </TraceLine>
                </TraceCollapsibleTrigger>
                <TraceCollapsibleContent>{details}</TraceCollapsibleContent>
            </TraceCollapsible>
        </Trace>
    );
}

/**
 * The most recent "Said" text of a running turn — what the assistant
 * announced alongside its latest tool calls, from any of the turn's
 * agentruns — flattened to one line for the summary.
 *
 * @param steps The turn's finished steps, oldest first.
 * @returns The text, or `null` when no step has said anything yet.
 */
function findLatestSaid(steps: readonly ChatStepDto[]): string | null {
    for (let index = steps.length - 1; index >= 0; index--) {
        const step = steps[index];
        if (!isSaidStep(step)) {
            continue;
        }
        const text = step.text.replace(/\s+/g, " ").trim();
        if (text.length > 0) {
            return text;
        }
    }
    return null;
}

/**
 * Whether a step shows a "Said" line: intermediate text next to tool
 * calls (text without tools is the answer itself).
 *
 * @param step The step.
 * @returns `true` for a "Said" step.
 */
function isSaidStep(step: ChatStepDto): step is ChatStepDto & { readonly text: string } {
    return step.text !== null && step.tools.length > 0;
}

/**
 * One agentrun and its steps.
 *
 * @param props.run The agentrun.
 * @param props.steps Its finished steps.
 * @returns The lines.
 */
function RunTrace({
    run,
    steps,
}: {
    readonly run: ChatRunDto;
    readonly steps: readonly ChatStepDto[];
}) {
    const status = runStatus(run);
    return (
        <div className="flex flex-col gap-1.5">
            <TraceLine status={status === "done" ? undefined : status}>
                <TraceIcon>
                    <StatusIcon status={status} />
                </TraceIcon>
                <TraceTitle>
                    {run.parentId === null ? "" : "↳ "}
                    {run.topic}
                </TraceTitle>
                <TraceDescription>
                    {[
                        run.model,
                        run.state === "waiting" ? "waiting for a subagent" : null,
                        run.error,
                    ]
                        .filter((part) => part !== null)
                        .join(" · ")}
                </TraceDescription>
            </TraceLine>
            {steps.length > 0 && (
                <div className="ml-6 flex flex-col gap-1.5">
                    {steps.map((step) => (
                        <StepTrace key={`${step.agentRunId}:${step.stepNumber}`} step={step} />
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * One step: reasoning, intermediate text, tool calls.
 *
 * @param props.step The step.
 * @returns The lines.
 */
function StepTrace({ step }: { readonly step: ChatStepDto }) {
    return (
        <>
            {step.reasoning !== null && (
                <Expandable title="Thought" body={step.reasoning} status="done" />
            )}
            {isSaidStep(step) && <Expandable title="Said" body={step.text} status="done" />}
            {step.tools.map((tool) => (
                <ToolTrace key={tool.id} tool={tool} />
            ))}
        </>
    );
}

/**
 * One tool call with its arguments and result.
 *
 * @param props.tool The call.
 * @returns The line.
 */
function ToolTrace({ tool }: { readonly tool: ChatToolCallDto }) {
    const status: TraceStatus = tool.isError ? "error" : tool.output === null ? "running" : "done";
    const body = [
        `Arguments: ${tool.input}`,
        tool.output === null ? null : `${tool.isError ? "Error" : "Result"}: ${tool.output}`,
    ]
        .filter((line) => line !== null)
        .join("\n\n");
    return <Expandable title={tool.name} description={tool.input} body={body} status={status} />;
}

/**
 * A collapsible trace line.
 *
 * @param props.title Line title.
 * @param props.description Short description next to the title.
 * @param props.body Text shown when expanded.
 * @param props.status Line state.
 * @returns The line.
 */
function Expandable({
    title,
    description,
    body,
    status,
}: {
    readonly title: string;
    readonly description?: string;
    readonly body: string;
    readonly status: TraceStatus;
}) {
    return (
        <TraceCollapsible>
            <TraceCollapsibleTrigger>
                <TraceLine status={status === "done" ? undefined : status}>
                    <TraceIcon>
                        <StatusIcon status={status} />
                    </TraceIcon>
                    <TraceTitle>{title}</TraceTitle>
                    {description !== undefined && (
                        <TraceDescription className="max-w-80 truncate font-mono text-xs">
                            {description}
                        </TraceDescription>
                    )}
                </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent className="font-mono text-xs break-all whitespace-pre-wrap">
                {body}
            </TraceCollapsibleContent>
        </TraceCollapsible>
    );
}

/**
 * Trace status of an agentrun.
 *
 * @param run The agentrun.
 * @returns The status.
 */
function runStatus(run: ChatRunDto): TraceStatus {
    switch (run.state) {
        case "pending":
            return "pending";
        case "running":
        case "waiting":
            return "running";
        case "failed":
            return "error";
        case "done":
            return "done";
    }
}
