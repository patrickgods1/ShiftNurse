#!/usr/bin/env bash
# Pipe the smoke requests through a built runner and check the answers.
#
# The model: maximise 3x + 4y subject to x + 2y <= 14, 3x - y >= 0, x - y <= 2, with x, y in
# [0, 10]. Worked by hand: the LP optimum is the intersection of x + 2y = 14 and x - y = 2, i.e.
# (6, 4), which is integral, so it is also the integer optimum — 3*6 + 4*4 = 34. CP-SAT minimises,
# so the model minimises -3x - 4y and the expected objective is -34.
#
# Usage: test/check.sh <path-to-cpsat-runner>
set -euo pipefail
runner="$1"
here="$(cd "$(dirname "$0")" && pwd)"
out="$("$runner" < "$here/smoke.jsonl")"
echo "$out"
fail() { echo "FAIL: $1" >&2; exit 1; }
grep -q '"type":"ready"' <<<"$out" || fail 'no ready event'
grep '"type":"error"' <<<"$out" | grep -q '"message":"bad request' \
  || fail 'a malformed request was not answered with an error'
result="$(grep '"type":"result","id":"smoke"' <<<"$out")" || fail 'no result for the smoke model'
grep -q '"status":"OPTIMAL"' <<<"$result" || fail "not optimal: $result"
grep -q '"objective":-34' <<<"$result" || fail "wrong objective: $result"
grep -q '"values":\["6","4"\]' <<<"$result" || fail "wrong solution: $result"
echo "cpsat-runner smoke OK"
