---
name: delegate
description: Orchestrate work by handing self-contained tasks — straightforward features, easy bug fixes, small refactors — to Sonnet `implementer` subagents, have an independent `reviewer` subagent check each result, and keep the main session on planning, dispatch and final judgement instead of editing code. Use when the user says "delegate this", "have subagents do it", "farm this out", "orchestrate", or gives a piece of work that splits into independent mechanical parts. Design decisions, the time model and solver internals stay with the main session.
---

# Delegate: the main session orchestrates, implementers do the work

Under this skill the main session **does not edit code**. Its job is to understand the
request, cut it into independent tasks, write a brief for each, dispatch them to
`implementer` agents (`.claude/agents/implementer.md`, Sonnet, edit + shell tools), send
each finished result to a `reviewer` agent (`.claude/agents/reviewer.md`, Sonnet,
read-only) that never saw the brief's reasoning, arbitrate the findings, and report to the
user. The only code the main session writes itself is
the part that is not delegable (Step 1) — and it says so explicitly when it does.

`Agent` and `SendMessage` below are Claude Code's own tools: `Agent` spawns a subagent from a
definition in `.claude/agents/`, and `SendMessage` continues a subagent that was spawned
earlier in the session, with its context intact — a fresh `Agent` call always starts cold.

Implementers start cold: no conversation context, no way to ask questions. The quality of
what comes back is decided by the brief, so most of the orchestrator's effort goes there.

## Step 1 — Decompose and classify

Break the request into tasks such that each one:

- can be described in a few sentences of finished behaviour, and a reviewer could tell from
  the diff alone whether it was met;
- has a known file list. If finding the files needs investigation, do that first in the main
  session (read the code, or use `Explore`), then brief the implementer with the answer;
- does not depend on a decision that has not been made yet — make the decision, put it in
  the brief;
- does not touch `packages/core/src/domain/time.ts`, a `Rule`'s severity or scope, the
  solver's objective or move set, or a migration that already exists. Those are the places
  where a plausible-looking change is silently wrong; they stay with the orchestrator.

Typical implementer tasks: an IPC method that mirrors an existing one; a repository function
with its audit entry; a renderer component that follows a sibling's pattern; a bug with a
known cause and a known fix; wiring a settings field end to end; tests for a case that is
already understood.

Then work out the dependency order. Tasks that touch disjoint files and do not import each
other's new exports run **in parallel — one agent per task, spawned in the same turn**.
Tasks that depend on another's output wait for it. Never give one agent a list of tasks; a
list is a sign the decomposition is not finished.

Tell the user the plan in a few lines before dispatching: which tasks, which run in
parallel, which (if any) the orchestrator will do itself and why.

## Step 2 — Write each brief

Everything goes in the `prompt`. The implementer reads `CLAUDE.md` itself, so do not paste
conventions; do paste the task-specific facts it cannot discover. Use this shape:

```
## Task
<one paragraph: what should be true when you are done, in behavioural terms>

## Why
<one or two sentences — the reason the change exists. The implementer writes WHY-comments
and this is where they come from>

## Files
- path/to/file.ts — <what changes here>
- path/to/file.test.ts — <what to test>
Read first: <the file whose pattern to copy, e.g. "repositories/timeoff.ts — mirror
createTimeOffRequest">

## Acceptance
- <observable check, e.g. "`schedule.validate` returns a `charge_missing` violation for a
  shift with no charge nurse">
- <observable check>
- `npm run check` is green

## Out of bounds
<nearby code it must not touch; decisions already made that it must not revisit; other
implementers' files if any are running in parallel>
```

Pin every name that would otherwise be invented: the exact `ViolationCode`, the IPC channel,
the column, the error text, the test file. When two parallel tasks share an interface (one
adds a repository function, another calls it), write the signature in both briefs so they
agree without talking to each other.

Spawn with:

```
Agent(subagent_type: "implementer", description: "<3–5 words>", prompt: <the brief>)
```

Run them in the background. While they work, do orchestrator work — prepare the next
brief, re-read the code you will review against — not implementation.

## Step 3 — Independent review, then orchestrator judgement

Implementer reports are not shown to the user; relay what matters. When an implementer
reports **Done**:

1. **Spawn a `reviewer`** for that task. It gets the acceptance criteria and the changed
   file list — deliberately *not* the full brief, the Why, or any of the orchestrator's
   reasoning. A reviewer that knows what the author intended will read the intent into the
   code; one that only knows what the code must do will notice when it doesn't.

   ```
   Agent(subagent_type: "reviewer", description: "Review <task>", prompt:
     "## Acceptance criteria\n<copied from the brief>\n\n## Changed files\n<from the
     implementer's report>")
   ```

   Reviewers for independent tasks run in parallel with each other and with implementers
   still working. Run it in the background unless the next dispatch depends on the verdict.

2. **Arbitrate the findings.** The reviewer is a second opinion, not the decider. For each
   finding decide whether it is real: open the file, check the line. Then:
   - Real defect → one `SendMessage` to the implementer that wrote it, quoting the finding.
     It keeps its context and fixes it. When it reports back, send the same reviewer the
     updated file list with `SendMessage` for a re-check — same agent, so it knows what it
     already looked at.
   - Not a defect (the reviewer lacked context the brief had) → note it and move on; do not
     argue with the reviewer.
   - Reviewer and implementer disagree on a domain question → that is the orchestrator's
     call, and usually a sign the brief left a decision open. Make it, tell both.

3. **Spot-check yourself regardless of the verdict.** `git diff --stat`, then the parts of
   the diff that the reviewer's checklist is weakest on: whether the change matches the
   *intent* of the brief (the reviewer only had the criteria), and scope creep into files
   neither the brief nor the report mentioned.

4. **Accept a verification claim only if it quotes real output.** "All green, 312 tests" is
   evidence; "should pass" is not. When in doubt, run `test-runner`.

5. **Blocked or Partial means the brief was wrong, not the agent.** Work out what fact or
   decision was missing, then continue the *same* implementer with `SendMessage` — it keeps
   the work it has done. Respawning with the identical brief is never the answer. If the
   task turns out not to be delegable, take that piece back and say so.

6. **Findings go back to the implementer, not into the orchestrator's editor.** Fix
   something yourself only if the agent is gone and the change is trivial.

Once every task has a `PASS` (or `PASS WITH NOTES` you have read and accepted), run
`test-runner` once over the combined result — parallel implementers each saw a green gate on
their own change, not on the union.

## Step 4 — Report

Tell the user what was built, per task, with file paths; each task's review verdict and
any finding you overruled (with the reason); what the final gate printed; and anything an
implementer or reviewer flagged as out of scope. Do not commit unless the user asked for
one.
