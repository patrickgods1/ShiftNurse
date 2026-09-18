# Provenance

Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT),
`skills/engineering/tdd`, pinned at commit `74ca5fe077456a0b3b2f5310cf9430999fd0b5fd`.

Vendored rather than installed via `npx skills@latest add` because that CLI does not
resolve this repo's nested `skills/engineering/<name>` layout — it reports "No skills
found" despite valid frontmatter. Vendoring also pins the version, so upstream edits
cannot change this project's behaviour without a deliberate update.

Content is unmodified. To update: re-fetch from a newer commit and review the diff.
