---
name: web-design-guidelines
description: Review renderer UI code against the vendored Vercel Web Interface Guidelines (accessibility, focus, forms, layout, typography, motion). Use when asked to "review my UI", "check accessibility", "audit design" or before ticking a UI milestone.
metadata:
  author: vercel (vendored, pinned — see SOURCE.md)
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review files for compliance with the Web Interface Guidelines.

The upstream skill fetches its rules from GitHub `main` on every run. This copy does not:
the rules live in `guidelines.md` next to this file, pinned to a known commit, so a review
today and a review next month apply the same rules and nothing remote is executed as
instructions. Update by re-vendoring and bumping the commit in `SOURCE.md`.

## How to use

1. Read `guidelines.md` in this directory.
2. Read the files named in the argument (default: `apps/desktop/src/renderer/src/**/*.tsx`;
   if the argument is empty and the change is not obvious, ask which files).
3. Check against every rule in the guidelines.
4. Output findings in the terse `file:line` format the guidelines specify. Skip rules that
   only apply to public websites (SEO, `<title>` per page, hydration) — this is an Electron
   renderer with one window.

## ShiftNurse specifics

- The schedule grid (M6) is the accessibility-critical surface: cells must be keyboard
  reachable and violations must not be conveyed by colour alone.
- Dates are ISO strings formatted through `renderer/src/format.ts`; flag any `new Date()`
  construction in a component.
