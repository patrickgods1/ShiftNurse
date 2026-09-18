#!/usr/bin/env bash
# PostToolUse hook: warn when the domain entity model changes.
#
# `core/domain/entities.ts` is the source of truth that `packages/db` mirrors as Drizzle
# tables. Editing one without the other is the most likely silent inconsistency in this
# codebase: nothing fails at compile time, and the mismatch surfaces later as a runtime
# error or, worse, a column that quietly never gets written.
#
# Reads the hook payload on stdin; prints nothing unless the guarded file was touched.
set -uo pipefail

file=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty' 2>/dev/null)
[ -n "$file" ] || exit 0

case "$file" in
  */core/src/domain/entities.ts)
    jq -n --arg c "entities.ts changed. The Drizzle schema in packages/db, a migration, and the repository layer likely need the matching change — and the demo seed may too. See ROADMAP.md M2." \
      '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
    ;;
esac
exit 0
