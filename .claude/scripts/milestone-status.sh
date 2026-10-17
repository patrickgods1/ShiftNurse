#!/usr/bin/env bash
# SessionStart hook: inject a one-line summary of roadmap progress.
#
# Saves every new session from reading ROADMAP.md just to answer "where are we?".
# Prints nothing if the roadmap is missing, so a fresh clone degrades quietly.
#
# Only the `## Milestones` section counts, and every `### ` heading in it is a milestone: a
# heading like "First-run setup" has no "M" prefix, and tracking only `### M` credited its open
# boxes to the previous milestone. The one marked "(in progress)" is current; deferred ones are
# skipped. $1 overrides the roadmap path (for testing).
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
roadmap="${1:-$repo_root/ROADMAP.md}"
[ -f "$roadmap" ] || exit 0

done_count=$(grep -c '^- \[x\]' "$roadmap" 2>/dev/null || true)
total_count=$(grep -cE '^- \[[ x]\]' "$roadmap" 2>/dev/null || true)

# One line per heading that has open boxes: "<open count>\t<in-progress 0|1>\t<heading>".
open_lines=$(awk '
  function flush() {
    if (heading != "" && opened > 0) print opened "\t" inprog "\t" heading
  }
  /^## / { flush(); heading = ""; insec = ($0 ~ /^## Milestones/); next }
  insec && /^### / {
    flush()
    heading = substr($0, 5)
    sub(/[[:space:]]*✅[[:space:]]*$/, "", heading)
    opened = 0
    inprog = (heading ~ /\(in progress\)/) ? 1 : 0
    if (heading ~ /\(deferred\)/) heading = ""
    next
  }
  insec && heading != "" && /^- \[ \]/ { opened++ }
  END { flush() }
' "$roadmap")

current=""
others=""
if [ -n "$open_lines" ]; then
  pick=$(printf '%s\n' "$open_lines" | awk -F'\t' '$2 == 1 { print NR; exit }')
  [ -z "$pick" ] && pick=1
  while IFS=$'\t' read -r n _ h; do
    i=$((${i:-0} + 1))
    if [ "$i" -eq "$pick" ]; then
      current="$h ($n open)"
    else
      others="${others:+$others; }$h ($n)"
    fi
  done <<< "$open_lines"
fi
[ -z "$current" ] && current="all milestones complete"

context="ShiftNurse: ${done_count}/${total_count} roadmap tasks complete. Current milestone: ${current}."
[ -n "$others" ] && context="$context Also open: ${others}."
context="$context ROADMAP.md is the plan of record; CLAUDE.md has architecture and conventions."

jq -n --arg c "$context" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
