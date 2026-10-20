// cpsat-runner: a long-lived CP-SAT process for ShiftNurse.
//
// OR-Tools has no JavaScript bindings, so the Electron main process spawns this binary and talks
// to it over stdin/stdout, one JSON line per message (schema: runner.proto). It stays alive across
// requests so the hybrid solver, which calls CP-SAT on many small windows per Generate, pays the
// process start-up once.
//
// Threading: the solve runs on a worker thread so the main thread can keep reading stdin — that is
// how a {"stop":true} line reaches a running solve (through the time limit's external boolean).
// A request that cannot be parsed echoes whatever id can still be read from it (unknown fields
// ignored), else an empty one. A stop carrying an id only stops the solve with that id; an empty id
// stops whatever is running (a v2 client). Only one solve runs at a time; a second request while
// one is in flight is answered with an error rather than queued, because the client already
// serialises its requests. Every write to stdout goes through one mutex so progress and results
// never interleave mid-line.
//
// The runner does no scheduling logic. Everything about nurses, rules and objectives is encoded
// by packages/core into the CpModelProto; this program only solves it and reports.

#include <atomic>
#include <chrono>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

#include "google/protobuf/json/json.h"
#include "ortools/init/init.h"
#include "ortools/sat/cp_model.pb.h"
#include "ortools/sat/cp_model_solver.h"
#include "ortools/sat/model.h"
#include "ortools/sat/sat_parameters.pb.h"
#include "ortools/util/time_limit.h"
#include "runner.pb.h"

namespace {

using operations_research::sat::CpSolverResponse;
using shiftnurse::cpsat::Event;
using shiftnurse::cpsat::Request;

std::mutex out_mu;

void Emit(const Event& event) {
  std::string json;
  google::protobuf::json::PrintOptions options;
  options.preserve_proto_field_names = true;
  // Always print status/objective/values, so "0" and "UNKNOWN" are explicit rather than absent.
  options.always_print_fields_with_no_presence = true;
  if (!google::protobuf::json::MessageToJsonString(event, &json, options).ok()) {
    json = R"({"type":"error","message":"could not serialise an event"})";
  }
  std::lock_guard<std::mutex> lock(out_mu);
  std::cout << json << '\n' << std::flush;
}

void EmitError(const std::string& id, const std::string& message) {
  Event event;
  event.set_type("error");
  event.set_id(id);
  event.set_message(message);
  Emit(event);
}

// The id of a line that failed to parse strictly, so the client can match the error to its request.
// A second, lenient parse recovers it when the line only carried a field this build does not know.
std::string BestEffortId(const std::string& line) {
  google::protobuf::json::ParseOptions lenient;
  lenient.ignore_unknown_fields = true;
  Request request;
  if (!google::protobuf::json::JsonStringToMessage(line, &request, lenient).ok()) return "";
  return request.id();
}

// A solve that ends by itself is bounded by this, so a runner orphaned by a client that died (or
// an older client that sent no limit) still stops. Matches SOLVE_VALVE_SECONDS in cpsat-process.ts.
constexpr double kDefaultMaxSeconds = 540;

// A 100-nurse x 42-day model encodes to a few MB; the cap stops a runaway line from being parsed
// into several times its size in protobuf objects.
constexpr size_t kMaxRequestBytes = 256 * 1024 * 1024;

int64_t MillisSince(std::chrono::steady_clock::time_point start) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now() - start)
      .count();
}

// Returns the result instead of emitting it: the CP-SAT Model is destroyed when this returns, and
// the caller clears `busy` before the answer leaves.
Event Solve(const Request& request, std::atomic<bool>* stop) {
  const auto start = std::chrono::steady_clock::now();
  operations_research::sat::SatParameters params = request.params();
  if (!params.has_max_time_in_seconds()) params.set_max_time_in_seconds(kDefaultMaxSeconds);
  operations_research::sat::Model model;
  model.Add(operations_research::sat::NewSatParameters(params));
  model.GetOrCreate<operations_research::TimeLimit>()->RegisterExternalBooleanAsLimit(stop);
  model.Add(operations_research::sat::NewFeasibleSolutionObserver(
      [&](const CpSolverResponse& response) {
        Event event;
        event.set_type("progress");
        event.set_id(request.id());
        event.set_objective(response.objective_value());
        event.set_bound(response.best_objective_bound());
        event.set_wall_ms(MillisSince(start));
        Emit(event);
      }));

  const CpSolverResponse response =
      operations_research::sat::SolveCpModel(request.model(), &model);

  Event event;
  event.set_type("result");
  event.set_id(request.id());
  event.set_status(response.status());
  event.set_objective(response.objective_value());
  event.set_bound(response.best_objective_bound());
  event.set_wall_ms(MillisSince(start));
  for (const int64_t v : response.solution()) event.add_values(v);
  return event;
}

}  // namespace

int main() {
  std::ios::sync_with_stdio(false);
  std::atomic<bool> stop{false};
  std::atomic<bool> busy{false};
  std::thread worker;
  // Id of the solve in flight. Only the main thread reads or writes it, so it needs no lock.
  std::string current_id;

  Event ready;
  ready.set_type("ready");
  ready.set_version(operations_research::OrToolsVersionString());
  Emit(ready);

  google::protobuf::json::ParseOptions parse;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty() || line == "\r") continue;
    if (line.size() > kMaxRequestBytes) {
      EmitError(BestEffortId(line), "request too large");
      continue;
    }
    Request request;
    const auto status = google::protobuf::json::JsonStringToMessage(line, &request, parse);
    if (!status.ok()) {
      EmitError(BestEffortId(line), std::string("bad request: ") + std::string(status.message()));
      continue;
    }
    if (request.stop()) {
      // A stop for a solve that has already finished must not cut the next one short.
      if (request.id().empty() || (busy && request.id() == current_id)) stop = true;
      continue;
    }
    if (busy) {
      EmitError(request.id(), "a solve is already running");
      continue;
    }
    if (worker.joinable()) worker.join();
    stop = false;
    busy = true;
    current_id = request.id();
    worker = std::thread([request = std::move(request), &stop, &busy]() {
      Event result = Solve(request, &stop);
      // Cleared before the answer leaves, so a request sent the moment the client reads it is
      // never refused.
      busy = false;
      Emit(result);
    });
  }

  // stdin closed: finish the solve in flight, then exit. A caller that wants it cut short sends
  // {"stop":true} first (the main process does, on cancel and on quit); treating EOF as a stop
  // would make `runner < requests.jsonl` stop every solve before it started. The wall valve in
  // Solve bounds it when the request set no time limit.
  if (worker.joinable()) worker.join();
  return 0;
}
