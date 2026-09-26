# Changelog

What changed for people running ShiftNurse, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the `vX.Y.Z` release
tags. Each release's notes link here.

## [Unreleased]

### Fixed
- The schedule no longer shows a green "0 hard · 0 soft violations" while its rules are still
  being checked, or when the check failed.
- A grid edit the app refuses (a locked shift, an archived period, a missing reason) now says
  so, instead of the shift silently snapping back.
- A locked shift can no longer be moved, and an archived schedule can no longer be changed in
  any way, including locking and unlocking shifts.
- After Generate or a call-off backfill, the compliance alerts and publish preview show the new
  schedule instead of the old one.
- The dashboard's "on shift today" lists only the published schedule, not nurses proposed in an
  overlapping draft.
- Restoring a backup while a schedule is generating no longer leaves the CP-SAT solver running
  after the app restarts.
- The packaged app on Windows could refuse its own window's requests when installed under a
  short (8.3) path.

### Changed
- Generate is faster: the SA + LNS solver takes about half as long, and the hybrid's annealing
  share speeds up the same way. The schedules produced are unchanged.
- Confirmations ("Delete this pay rate?") use the app's own dialog, with the button named for
  what it does.
- The schedule grid works from the keyboard: arrow keys move between days and nurses, Enter adds
  a shift, and a shift's dialog has **Move to**.
- Regenerating a schedule records which shifts it replaced in the audit log.

### Security
- Dropping a file on the window can no longer load it inside the app, and only the app's own
  page can reach its data.
- drizzle-orm 0.45.3 (GHSA-gpj5-g38j-94v9).

## [0.1.0] - 2026-09-25

First release: unsigned installers for macOS (Apple silicon and Intel) and Windows, built and
self-tested on GitHub Actions. Roster, demand and acuity, schedule grid with live rule checks,
Generate with three solvers (hybrid, SA + LNS, CP-SAT), fairness, cost and budget, time-off and
shift-exchange requests with conflict resolution, publishing with a change log and exports, and
the day-of call-off console.

[Unreleased]: https://github.com/patrickgods1/ShiftNurse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/patrickgods1/ShiftNurse/releases/tag/v0.1.0
