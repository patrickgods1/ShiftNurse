ShiftNurse {{VERSION}} — a local desktop app that builds contract-compliant nurse unit schedules.

What changed in this version: see
[CHANGELOG.md](https://github.com/patrickgods1/ShiftNurse/blob/main/CHANGELOG.md).

## Download

| Your computer | File |
|---|---|
| Mac with Apple silicon (M1 or later) | `ShiftNurse-{{VERSION}}-mac-arm64.dmg` |
| Mac with an Intel processor | `ShiftNurse-{{VERSION}}-mac-x64.dmg` |
| Windows 10/11 (64-bit) | `ShiftNurse-{{VERSION}}-win-x64.exe` |

Not sure which Mac you have? Apple menu › About This Mac: "Chip: Apple M…" is Apple silicon;
"Processor: Intel…" is Intel.

## These builds are not code-signed yet

Your computer will warn that it cannot verify the developer. That is expected for this release.

- **macOS**: open the `.dmg` and drag ShiftNurse to Applications, then open it once. macOS says
  it cannot verify the developer: click **Done**. Then open **System Settings › Privacy &
  Security**, scroll to **Security**, click **Open Anyway** next to "ShiftNurse was blocked", and
  confirm with your password. ShiftNurse opens normally from then on. (On macOS 14 and earlier,
  right-click ShiftNurse in Applications and choose **Open** instead; macOS 15 removed that
  shortcut for unsigned apps.) If macOS says the app "is damaged and can't be opened", run this
  once in Terminal and open it again: `xattr -dr com.apple.quarantine /Applications/ShiftNurse.app`
- **Windows**: if SmartScreen says "Windows protected your PC", click **More info**, then
  **Run anyway**.

## Check your download

The SHA-256 of each installer is at the end of these notes, and `SHA256SUMS` lists every file. On macOS run `shasum -a 256 <file>` in Terminal; on
Windows run `certutil -hashfile <file> SHA256` in PowerShell. The output must match the file's line
exactly; if it does not, the download is damaged or not ours — delete it and download it again.

## Every build is tested

Each installer was built on its own platform on GitHub Actions and then launched in a headless
self-test. The test generates a schedule with each solver twice, checks the two runs agree, and
exercises publishing, exports and the day-of console.

The CP-SAT and hybrid solvers use Google OR-Tools (Apache-2.0); see
[Credits and references](https://github.com/patrickgods1/ShiftNurse#credits-and-references) and
the installed `resources/cpsat/THIRD_PARTY_NOTICES.md`. For how the solvers compare, see
[the solver benchmark](https://github.com/patrickgods1/ShiftNurse/blob/main/docs/solver-bench.md).
