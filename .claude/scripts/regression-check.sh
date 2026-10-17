#!/usr/bin/env bash
# Stop hook: run the tests related to this turn's changes and report ONLY failures.
#
# Deliberately non-blocking. A Stop hook that blocks can trap the session in a loop when a
# test is legitimately red mid-refactor, which is worse than the problem it solves. This
# surfaces the failure and lets the human decide.
#
# Related tests only, `unit` project only, under a 100 s self-budget: the full suite takes
# minutes and could never finish inside the hook's 120 s timeout, so a kill was swallowed and
# the hook never reported anything. Running out of budget is now said out loud.
#
# WATCHDOG_SECONDS is a test-only override of the budget (default 100).
#
# Passing runs print nothing at all, so the common case costs no context.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root" || exit 0

# No test harness yet (fresh clone, deps not installed) — stay silent.
[ -d node_modules ] || exit 0

# `vitest related` cannot take a deleted file, so keep only files that still exist. A `while
# read` loop because macOS ships bash 3.2, which has no mapfile.
files=()
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] && files+=("$f")
done < <({
  git diff --name-only HEAD -- '*.ts' '*.tsx' '*.mjs'
  git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.mjs'
} 2>/dev/null | sort -u)
[ "${#files[@]}" -gt 0 ] || exit 0

log=$(mktemp)
marker=$(mktemp)
rm -f "$marker"
pid=""
watchdog=""
budget="${WATCHDOG_SECONDS:-100}"

# Every descendant of $1, deepest first. npx -> node -> vitest workers is several levels, and
# pkill -P only reaches one; killing by name would take down unrelated vitest runs.
descendants() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do
    descendants "$c"
    echo "$c"
  done
}
cleanup() {
  # The sleep is the watchdog subshell's child; killing only the subshell would leave it behind.
  [ -n "$watchdog" ] && { pkill -TERM -P "$watchdog" 2>/dev/null; kill "$watchdog" 2>/dev/null; }
  rm -f "$log" "$marker"
}
trap cleanup EXIT

npx --no-install vitest related --run --project unit --reporter=dot --passWithNoTests \
  "${files[@]}" >"$log" 2>&1 &
pid=$!

# Stands in for timeout(1), which macOS lacks. Kills vitest's children too, or workers outlive it.
(
  sleep "$budget"
  touch "$marker"
  # Collect before killing: once a parent dies its children are reparented and unfindable.
  victims=$(descendants "$pid")
  for v in $victims $pid; do kill -TERM "$v" 2>/dev/null; done
) >/dev/null 2>&1 &
watchdog=$!
disown "$watchdog" 2>/dev/null

wait "$pid"
status=$?

if [ -e "$marker" ] || [ "$status" -eq 143 ]; then
  jq -n --arg m "Stop hook: the tests related to this turn's changes did not finish within ${budget} s, so nothing was checked. Run npm test before committing." '{systemMessage:$m}'
  exit 0
fi

[ "$status" -eq 0 ] && exit 0

# Keep only the tail: the failure summary, not the whole run.
summary=$(tail -n 25 "$log")
jq -n --arg m "Tests are failing at end of turn:"$'\n'"$summary" '{systemMessage:$m}'
exit 0
