#!/bin/bash
# Sends a single chat message to the running agent container via the
# IPC directory. The host daemon must already be running (cli/start.sh).
#
# Usage: ./cli.sh chat "<prompt>"
#        echo "<prompt>" | ./cli.sh chat

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_DIR="${PROJECT_ROOT}/data"
PID_FILE="${DATA_DIR}/.daemon.pid"
INPUT_DIR="${DATA_DIR}/ipc/input"
OUTPUT_DIR="${DATA_DIR}/ipc/output"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<EOF
Usage: cli.sh chat <prompt>
       echo <prompt> | cli.sh chat
EOF
  exit 0
fi

# Verify the daemon is alive.
if [ ! -f "${PID_FILE}" ]; then
  echo "Error: daemon not running (no ${PID_FILE}). Start it with: ./cli.sh start" >&2
  exit 1
fi
pid="$(cat "${PID_FILE}")"
if [ -z "${pid}" ] || ! kill -0 "${pid}" 2>/dev/null; then
  echo "Error: stale pidfile (${PID_FILE}). Start the daemon: ./cli.sh start" >&2
  exit 1
fi

# Collect prompt: positional args win; otherwise read stdin if piped.
prompt="$*"
if [ -z "${prompt}" ] && [ ! -t 0 ]; then
  prompt="$(cat)"
fi
if [ -z "${prompt}" ]; then
  echo "Error: no prompt provided. Pass as an argument or pipe via stdin." >&2
  exit 1
fi

mkdir -p "${INPUT_DIR}" "${OUTPUT_DIR}"

# Generate an 8-char hex task id.
task_id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

input_path="${INPUT_DIR}/${task_id}.json"
output_path="${OUTPUT_DIR}/${task_id}.json"

# Compose the input JSON. Node is already a project dependency, so use it
# for safe string escaping (avoids relying on jq or python).
TASK_ID="${task_id}" PROMPT="${prompt}" node -e \
  'process.stdout.write(JSON.stringify({task:{taskId:process.env.TASK_ID,prompt:process.env.PROMPT}}))' \
  >"${input_path}"

# Poll for the result file. Default timeout 600s (chat replies can be slow).
timeout_s="${CHAT_TIMEOUT_S:-600}"
deadline=$(( $(date +%s) + timeout_s ))

while [ ! -f "${output_path}" ]; do
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "Error: timed out after ${timeout_s}s waiting for ${output_path}" >&2
    exit 1
  fi
  sleep 0.2
done

cat "${output_path}"
echo
rm -f "${output_path}" "${OUTPUT_DIR}/${task_id}.log.jsonl"
