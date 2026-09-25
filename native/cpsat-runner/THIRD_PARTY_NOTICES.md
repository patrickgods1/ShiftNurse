# Third-party notices — cpsat-runner

`cpsat-runner` is part of ShiftNurse. It links against **Google OR-Tools** and ships the
OR-Tools shared libraries it loads. Each component below keeps its own licence; the full texts
are in the `licenses/` folder installed next to the runner in every bundle (and in
`native/cpsat-runner/licenses/` in the source tree). SCIP's and SoPlex's licence files are
copied from the OR-Tools release archive at build time.

| Component | Used for | Licence | Source |
|---|---|---|---|
| [Google OR-Tools](https://developers.google.com/optimization) v9.15, including the **CP-SAT** solver | The constraint solver itself | Apache-2.0 (`ortools-LICENSE`) | https://github.com/google/or-tools |
| [Abseil](https://abseil.io) | OR-Tools dependency | Apache-2.0 (`abseil-LICENSE`) | https://github.com/abseil/abseil-cpp |
| [Protocol Buffers](https://protobuf.dev), incl. utf8_range | Model format and the runner's JSON protocol | BSD-3-Clause (`protobuf-LICENSE`); MIT (`utf8_range-LICENSE`) | https://github.com/protocolbuffers/protobuf |
| [RE2](https://github.com/google/re2) | OR-Tools dependency | BSD-3-Clause (`re2-LICENSE`) | https://github.com/google/re2 |
| [HiGHS](https://highs.dev) | Linear solver bundled with OR-Tools | MIT (`highs-LICENSE`) | https://github.com/ERGO-Code/HiGHS |
| [SCIP](https://www.scipopt.org) and [SoPlex](https://soplex.zib.de) | MIP/LP solvers bundled with OR-Tools | Apache-2.0 (`scip/`, `soplex/` from the OR-Tools archive) | https://github.com/scipopt/scip |
| [COIN-OR](https://www.coin-or.org) CBC, CLP, CGL, CoinUtils, OSI | MIP/LP solvers bundled with OR-Tools | EPL-2.0 (`coin-or-EPL-2.0`) | https://github.com/coin-or — source for these binaries is available from the COIN-OR projects at the versions OR-Tools v9.15 pins |
| [Eigen](https://eigen.tuxfamily.org) | Linear algebra, compiled into OR-Tools | MPL-2.0 (`eigen-MPL2`) | https://gitlab.com/libeigen/eigen |
| [zlib](https://zlib.net) | Compression | zlib licence (`zlib-LICENSE`) | https://github.com/madler/zlib |
| [bzip2](https://sourceware.org/bzip2/) | Compression | bzip2 licence (`bzip2-COPYING`) | https://gitlab.com/bzip2/bzip2 |
| Microsoft Visual C++ runtime (Windows bundle only: `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`) | C++ runtime for the Windows build | Redistributed under Microsoft's Visual Studio distributable-code terms | https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files |

CP-SAT is the work of Laurent Perron, Frédéric Didier, Steven Gay and the OR-Tools team at
Google. Cite it as the OR-Tools project asks (https://developers.google.com/optimization/support/cite):

- Laurent Perron and Vincent Furnon. *OR-Tools*, v9.15. Google. https://developers.google.com/optimization/
- Laurent Perron and Frédéric Didier. *CP-SAT*, v9.15. Google. https://developers.google.com/optimization/cp/cp_solver/
- Laurent Perron, Frédéric Didier and Steven Gay. "The CP-SAT-LP Solver." *29th International
  Conference on Principles and Practice of Constraint Programming (CP 2023)*, LIPIcs 280,
  pp. 3:1–3:2. doi:10.4230/LIPIcs.CP.2023.3
