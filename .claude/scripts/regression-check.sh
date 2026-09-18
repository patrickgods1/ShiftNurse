#!/usr/bin/env bash
# Stop hook: run the test suite and report ONLY failures.
#
# Deliberately non-blocking. A Stop hook that blocks can trap the session in a loop when a
# test is legitimately red mid-refactor, which is worse than the problem it solves. This
# surfaces the failure and lets the human decide.
#
# Passing runs print nothing at all, so the common case costs no context.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root" || exit 0

# No test harness yet (fresh clone, deps not installed) — stay silent.
[ -d node_modules ] || exit 0

if output=$(npx --no-install vitest run --reporter=dot 2>&1); then
  exit 0
fi

# Keep only the tail: the failure summary, not the whole run.
summary=$(printf '%s' "$output" | tail -n 25)
jq -n --arg m "Tests are failing at end of turn:"$'\n'"$summary" '{systemMessage:$m}'
exit 0
