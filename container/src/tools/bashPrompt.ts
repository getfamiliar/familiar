import { getPythonPackages, getWritablePaths } from "../env.js";
import type { PromptContributor } from "../prompt-contributors.js";

/**
 * Contributes the `## The bash tool` help section to the per-run
 * dynamic context block — but only when `bash` is in the run's active
 * tool set, so handlers that don't get the tool aren't told about it.
 *
 * The wording branches on `privileged`: a privileged run executes as
 * the `priv` user with full workspace write; a non-privileged run drops
 * to the `unpriv` user, confined by the OS to `/scratch` plus
 * `core.writablePaths`. The python-package list is the image's baked
 * venv (forwarded via `AGENT_PYTHON_PACKAGES`); the section always notes
 * that bash is offline so the agent doesn't attempt network access or
 * runtime `pip install`.
 */
export const bashPromptContributor: PromptContributor = (ctx) => {
    if (!ctx.toolNames.includes("bash")) {
        return null;
    }

    const accessLine = ctx.privileged
        ? "The command runs as the `priv` user; you have write access to `/workspace` and `/scratch`."
        : buildUnprivAccessLine(getWritablePaths());

    const packages = getPythonPackages();
    const packagesSentence =
        packages.length > 0
            ? `The following packages are installed: ${packages.join(", ")}. ` +
              "The user may install more packages via the config file."
            : "The user may install python packages via the config file.";

    return [
        "## The bash tool",
        "",
        `You can call the tool \`bash\` to execute arbitrary bash commands. ${accessLine}`,
        "",
        `You can use \`python3\` (on PATH) to solve your tasks. ${packagesSentence}`,
        "",
        "The bash tool is OFFLINE: inside bash you have no internet access and cannot install additional python packages.",
    ].join("\n");
};

/**
 * Build the unprivileged write-access sentence, listing the
 * `core.writablePaths` globs in addition to `/scratch`. When no
 * writable paths are configured, the trailing "and: …" clause is
 * dropped so the sentence stays grammatical.
 *
 * @param writablePaths Workspace-relative globs from `core.writablePaths`.
 * @returns The access sentence describing the `unpriv` user's reach.
 */
function buildUnprivAccessLine(writablePaths: readonly string[]): string {
    const base = "The command runs as the `unpriv` user; you have write access to `/scratch`";
    if (writablePaths.length === 0) {
        return `${base}.`;
    }
    const list = writablePaths.map((path) => `\`${path}\``).join(", ");
    return `${base} and: ${list}.`;
}
