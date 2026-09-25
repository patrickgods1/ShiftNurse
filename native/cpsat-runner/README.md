# cpsat-runner

A small C++ program that runs Google OR-Tools' CP-SAT solver for ShiftNurse. OR-Tools has no
JavaScript bindings, so the Electron main process spawns this binary and talks to it over
stdin/stdout. It does no scheduling logic: `packages/core` encodes the schedule as a
`CpModelProto`; the runner solves it and reports back.

It is built on **[Google OR-Tools](https://developers.google.com/optimization)** and its
**CP-SAT** solver (Apache-2.0), by Laurent Perron, Frédéric Didier and the OR-Tools team at
Google. Every bundle carries `THIRD_PARTY_NOTICES.md` and a `licenses/` folder with the licence
of OR-Tools and of each library it ships (Abseil, Protocol Buffers, RE2, HiGHS, SCIP, SoPlex,
COIN-OR, Eigen, zlib, bzip2, and on Windows the MSVC runtime) — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), including how to cite OR-Tools and CP-SAT.

## Protocol

One JSON message per line in each direction; the schema is [`runner.proto`](runner.proto).
Field names are the proto names (snake_case). Output int64 fields (`wall_ms`, `values`) are
strings, as protobuf's JSON mapping requires; every field is always present.

| Direction | Message | Meaning |
|---|---|---|
| out | `{"type":"ready","version":"9.15.6755",…}` | Once at start-up. |
| in | `{"id":"r1","model":{…CpModelProto…},"params":{…SatParameters…}}` | Solve. |
| out | `{"type":"progress","id":"r1","objective":…,"bound":…,"wall_ms":"…",…}` | Each improving solution. |
| out | `{"type":"result","id":"r1","status":"OPTIMAL","values":["6","4"],"objective":…,"bound":…,…}` | Exactly one per request. |
| out | `{"type":"error","id":"r1","message":"…"}` | Instead of a result. `id` is empty if the line could not be parsed at all. |
| in | `{"stop":true}` | Stop the solve in flight; it still sends its `result` with the best solution so far. |

One solve at a time: a request while one is running gets an `error`. Closing stdin lets the
solve in flight finish, then the runner exits; send `stop` first to cut it short.

## Building locally (macOS)

```sh
brew install cmake
gh release download v9.15 -R google/or-tools -p 'or-tools_arm64_macOS-26.2_cpp_v9.15.6755.tar.gz'
tar xzf or-tools_arm64_macOS-26.2_cpp_v9.15.6755.tar.gz
cmake -S native/cpsat-runner -B build -DORTOOLS_ROOT="$PWD/or-tools_arm64_macOS-26.2_cpp_v9.15.6755" -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
cmake --install build --prefix dist        # dist/cpsat-runner + dist/lib/*.dylib + dist/licenses/ (~50 MB)
native/cpsat-runner/test/check.sh dist/cpsat-runner
```

`cmake --install` copies exactly the OR-Tools shared libraries the runner loads (into `lib/` on
macOS, next to the `.exe` on Windows, plus the MSVC runtime DLLs there) and fails if any
dependency cannot be resolved.

## Releasing

CI (`.github/workflows/cpsat-runner.yml`) builds and smoke-tests macOS arm64, macOS x64 and
Windows x64 on every push that touches this directory. Pushing a tag `cpsat-runner-vN` also
publishes `cpsat-runner-<platform>-<arch>.tar.gz` and `SHA256SUMS` as a GitHub release. To ship a
new runner, tag it, then update the tag and hashes pinned in `apps/desktop/scripts/fetch-cpsat.mjs`.

## Bumping OR-Tools

Change the version in `CMakeLists.txt` (tag and the two `.proto` hashes), the archive names in the
workflow matrix and this README, rebuild, and cut a new `cpsat-runner-v*` tag.
