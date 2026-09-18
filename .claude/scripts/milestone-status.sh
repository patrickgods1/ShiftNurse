#!/usr/bin/env bash
# SessionStart hook: inject a one-line summary of roadmap progress.
#
# Saves every new session from reading ROADMAP.md just to answer "where are we?".
# Prints nothing if the roadmap is missing, so a fresh clone degrades quietly.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
roadmap="$repo_root/ROADMAP.md"
[ -f "$roadmap" ] || exit 0

done_count=$(grep -c '^- \[x\]' "$roadmap" 2>/dev/null || echo 0)
total_count=$(grep -cE '^- \[[ x]\]' "$roadmap" 2>/dev/null || echo 0)

# The current milestone is the first heading that still has an unchecked box under it.
current=$(awk '
  /^### M/ { heading = $0 }
  /^- \[ \]/ { if (heading != "") { print heading; exit } }
' "$roadmap")

if [ -z "$current" ]; then
  current="all milestones complete"
fi

context="ShiftNurse: ${done_count}/${total_count} roadmap tasks complete. Current milestone: ${current}. ROADMAP.md is the plan of record; CLAUDE.md has architecture and conventions."

jq -n --arg c "$context" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
