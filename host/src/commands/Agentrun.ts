import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";
import { HostConfigService } from "../config/ConfigService.js";
import { PostgresContainer } from "../db/PostgresContainer.js";

/**
 * `ea agentrun <id> [--full]` — print one agentrun's full transcript:
 * the row itself plus every persisted step (`stepresults`) in order.
 *
 * Built primarily to debug "the model said it would call a tool but
 * the step finished with `finish_reason: other` and nothing happened"
 * cases without dropping into psql. Pair with the reverse-proxy body
 * capture (`inference.captureBodies: true` in `config.yml`) to also
 * inspect the raw upstream HTTP response that produced the step.
 *
 * Truncates long text fields to keep the output readable; pass
 * `--full` to disable truncation.
 */
const TEXT_TRUNCATE_AT = 800;
const JSON_TRUNCATE_AT = 4000;

export const agentrunCommand = defineCommand({
    meta: {
        name: "agentrun",
        description: "Dump one agentrun's row plus every persisted step.",
    },
    args: {
        id: {
            type: "positional",
            required: true,
            description: "Agentrun id (numeric, from the agentruns table).",
        },
        full: {
            type: "boolean",
            default: false,
            description: "Disable text/JSON truncation in the output.",
        },
    },
    async run({ args }) {
        const id = args.id;
        if (!/^\d+$/.test(id)) {
            throw new Error(
                `Invalid agentrun id ${JSON.stringify(id)} — expected a positive integer.`,
            );
        }
        const full = Boolean(args.full);

        const boot = bootstrap();
        const config = new HostConfigService(boot.configFile);
        const password = config.getString("core.postgresPassword");

        const postgres = new PostgresContainer({
            dataPath: boot.dataDir,
            portFilePath: boot.postgresPortFile,
            password,
        });
        const connection = postgres.getConnection();
        try {
            const pool = connection.getPool();
            const runResult = await pool.query(
                `SELECT id, event_id, parent_agentrun_id, topic, handler, priority, state,
                        prompt, payload, result, result_text, error, privileged,
                        created_at, updated_at
                 FROM agentruns
                 WHERE id = $1`,
                [id],
            );
            if (runResult.rows.length === 0) {
                process.stderr.write(`No agentrun with id=${id}.\n`);
                process.exit(1);
            }
            const run = runResult.rows[0];
            printAgentrun(run, full);

            const stepResult = await pool.query(
                `SELECT step_number, finish_reason, result_text, reasoning_text,
                        input_tokens, output_tokens, total_tokens,
                        tool_call_count, tool_calls, tool_results, created_at
                 FROM stepresults
                 WHERE agent_run_id = $1
                 ORDER BY step_number`,
                [id],
            );
            if (stepResult.rows.length === 0) {
                process.stdout.write("\n(no stepresults rows)\n");
            } else {
                process.stdout.write(`\n--- ${stepResult.rows.length} step(s) ---\n`);
                for (const step of stepResult.rows) {
                    printStep(step, full);
                }
            }
        } finally {
            await connection.close();
        }
    },
});

/** Print the agentruns row with one-line-per-field formatting. */
function printAgentrun(run: Record<string, unknown>, full: boolean): void {
    const out = process.stdout;
    out.write("--- agentrun ---\n");
    out.write(`id:                 ${String(run.id)}\n`);
    out.write(`event_id:           ${String(run.event_id)}\n`);
    out.write(`parent_agentrun_id: ${run.parent_agentrun_id ?? "(root)"}\n`);
    out.write(`topic:              ${String(run.topic)}\n`);
    out.write(`handler:            ${String(run.handler)}\n`);
    out.write(`priority:           ${String(run.priority)}\n`);
    out.write(`state:              ${String(run.state)}\n`);
    out.write(`privileged:         ${String(run.privileged)}\n`);
    out.write(`created_at:         ${formatTs(run.created_at)}\n`);
    out.write(`updated_at:         ${formatTs(run.updated_at)}\n`);
    out.write(`prompt:             ${truncateText(run.prompt, full)}\n`);
    out.write(`payload:            ${truncateJson(run.payload, full)}\n`);
    out.write(`result_text:        ${truncateText(run.result_text, full)}\n`);
    out.write(`result:             ${truncateJson(run.result, full)}\n`);
    out.write(`error:              ${truncateText(run.error, full)}\n`);
}

/** Print one stepresults row. */
function printStep(step: Record<string, unknown>, full: boolean): void {
    const out = process.stdout;
    out.write(`\nstep #${String(step.step_number)} @ ${formatTs(step.created_at)}\n`);
    out.write(`  finish_reason:   ${String(step.finish_reason)}\n`);
    out.write(
        `  tokens:          in=${step.input_tokens ?? "?"} out=${step.output_tokens ?? "?"} total=${step.total_tokens ?? "?"}\n`,
    );
    out.write(`  tool_call_count: ${String(step.tool_call_count)}\n`);
    out.write(`  result_text:     ${truncateText(step.result_text, full)}\n`);
    if (step.reasoning_text !== null && step.reasoning_text !== undefined) {
        out.write(`  reasoning_text:  ${truncateText(step.reasoning_text, full)}\n`);
    }
    out.write(`  tool_calls:      ${truncateJson(step.tool_calls, full)}\n`);
    out.write(`  tool_results:    ${truncateJson(step.tool_results, full)}\n`);
}

/**
 * Format a `Date` (or ISO-string-ish value) as a compact ISO without
 * the "T" / millisecond noise. Falls back to `String(value)` for any
 * non-Date input.
 */
function formatTs(value: unknown): string {
    if (value instanceof Date) {
        return value
            .toISOString()
            .replace("T", " ")
            .replace(/\.\d+Z$/, "Z");
    }
    return String(value);
}

/**
 * Truncate a free-text field for terminal display. `null`/`undefined`
 * render as `(null)`. Returns the string verbatim when `full` is true.
 */
function truncateText(value: unknown, full: boolean): string {
    if (value === null || value === undefined) {
        return "(null)";
    }
    const text = String(value);
    if (full || text.length <= TEXT_TRUNCATE_AT) {
        return text;
    }
    return `${text.slice(0, TEXT_TRUNCATE_AT)}\n  …[+${text.length - TEXT_TRUNCATE_AT} chars; pass --full to expand]`;
}

/**
 * Pretty-print a JSON-like field with truncation. Same null handling
 * and `--full` semantics as {@link truncateText}.
 */
function truncateJson(value: unknown, full: boolean): string {
    if (value === null || value === undefined) {
        return "(null)";
    }
    const json = JSON.stringify(value, null, 2);
    if (full || json.length <= JSON_TRUNCATE_AT) {
        return json;
    }
    return `${json.slice(0, JSON_TRUNCATE_AT)}\n  …[+${json.length - JSON_TRUNCATE_AT} chars; pass --full to expand]`;
}
