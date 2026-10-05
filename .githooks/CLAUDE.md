# .githooks

> Loaded automatically when Claude works on files under this folder. Cross-cutting rules live in the root `CLAUDE.md`.

## Git hooks (`.githooks/`, wired by `npm install` via the `prepare` script)

- **`pre-commit`** runs a fast mechanical gate — `biome check --staged`, an incremental
  typecheck, and `vitest related` for the staged files minus the real-runner CP-SAT test (~6 s;
  CI runs the full `npm run check` on three platforms) — then sends the staged diff to a
  headless Claude reviewer (`claude -p`, Sonnet, read-only tools) briefed on this repo's
  invariants. A `VERDICT: BLOCK` aborts the commit with the findings printed. Budget about a
  minute. `FULL_CHECK=1` runs the full `npm run check` instead; `SKIP_REVIEW=1` keeps the
  mechanical gate but skips the review; `--no-verify` skips both.
- **`prepare-commit-msg`** drafts a plain-English message from the staged diff for a bare
  `git commit`; it never touches a message given with `-m`/`-F`. To commit non-interactively
  with a drafted message: run `.githooks/prepare-commit-msg <file> ""` then `git commit -F <file>`.
- The review fails *open* (no verdict → not blocked) so a flaky reviewer cannot wedge the
  repo; the mechanical gate fails closed.
