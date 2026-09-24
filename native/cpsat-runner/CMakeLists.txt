# cpsat-runner — built against a pinned OR-Tools C++ release archive.
#
#   OR-Tools v9.15 (build 6755), from https://github.com/google/or-tools/releases/tag/v9.15
#     mac arm64: or-tools_arm64_macOS-26.2_cpp_v9.15.6755.tar.gz   (libraries target macOS 11)
#     mac x64:   or-tools_x86_64_macOS-26.2_cpp_v9.15.6755.tar.gz
#     win x64:   or-tools_x64_VisualStudio2022_cpp_v9.15.6755.zip
#
# Configure with -DORTOOLS_ROOT=<extracted archive>. `cmake --install` lays out a self-contained
# directory: the executable plus exactly the OR-Tools shared libraries it loads (lib/ on macOS,
# next to the .exe on Windows), which is what ships inside the Electron app's resources/cpsat.
cmake_minimum_required(VERSION 3.24)
project(cpsat_runner LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Match the OR-Tools libraries")

set(ORTOOLS_ROOT "" CACHE PATH "Extracted OR-Tools C++ release archive")
if(NOT ORTOOLS_ROOT)
  message(FATAL_ERROR "Set -DORTOOLS_ROOT to the extracted OR-Tools C++ archive")
endif()
list(PREPEND CMAKE_PREFIX_PATH "${ORTOOLS_ROOT}")
find_package(ortools CONFIG REQUIRED)

# The release archive ships the generated .pb.h headers but not the .proto sources runner.proto
# imports, so fetch those from the same tag. The hashes pin them to the headers being linked.
set(ORTOOLS_TAG v9.15)
set(PROTO_DIR "${CMAKE_CURRENT_BINARY_DIR}/ortools-protos")
foreach(entry
    "cp_model.proto=c967180600fab5db4fc8b7477fef56c3c6d3c0714b1f0355697f96d147f77d96"
    "sat_parameters.proto=9a5e08486a63414191870bd9953f9e561af221e165654913a33662bf1b674308")
  string(REPLACE "=" ";" parts "${entry}")
  list(GET parts 0 name)
  list(GET parts 1 sha)
  file(DOWNLOAD
    "https://raw.githubusercontent.com/google/or-tools/${ORTOOLS_TAG}/ortools/sat/${name}"
    "${PROTO_DIR}/ortools/sat/${name}"
    EXPECTED_HASH SHA256=${sha}
    TLS_VERIFY ON)
endforeach()

add_executable(cpsat-runner main.cc runner.proto)
target_link_libraries(cpsat-runner PRIVATE ortools::ortools)
protobuf_generate(
  TARGET cpsat-runner
  LANGUAGE cpp
  IMPORT_DIRS "${CMAKE_CURRENT_SOURCE_DIR}" "${PROTO_DIR}"
  PROTOC_OUT_DIR "${CMAKE_CURRENT_BINARY_DIR}")
target_include_directories(cpsat-runner PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")

if(APPLE)
  # The build tree links against the archive's lib/ (CMake's default build rpath); the installed
  # binary finds its bundled copies next to it. install_name_tool re-signs ad-hoc on rewrite.
  set_target_properties(cpsat-runner PROPERTIES INSTALL_RPATH "@loader_path/lib")
  set(RUNNER_LIB_DIR lib)
else()
  # Windows loads DLLs from the executable's own directory.
  set(RUNNER_LIB_DIR .)
endif()

install(TARGETS cpsat-runner RUNTIME DESTINATION .)
# Copy exactly the OR-Tools shared libraries the runner loads — resolved from the build-tree
# binary, whose rpath still points into the archive — and fail the install on any it cannot find,
# so a release never ships a runner that dies at launch with a missing library.
install(CODE "set(ORTOOLS_ROOT \"${ORTOOLS_ROOT}\")\nset(RUNNER_LIB_DIR \"${RUNNER_LIB_DIR}\")")
install(CODE [[
  file(GET_RUNTIME_DEPENDENCIES
    EXECUTABLES "$<TARGET_FILE:cpsat-runner>"
    RESOLVED_DEPENDENCIES_VAR resolved
    UNRESOLVED_DEPENDENCIES_VAR unresolved
    DIRECTORIES "${ORTOOLS_ROOT}/lib" "${ORTOOLS_ROOT}/bin"
    PRE_EXCLUDE_REGEXES "api-ms-.*" "ext-ms-.*"
    # The MSVC runtime is not guaranteed on a fresh Windows 11 machine; Microsoft permits
    # app-local copies of these DLLs, so ship them next to the runner instead of excluding them.
    POST_INCLUDE_REGEXES ".*[/\\\\]([Mm][Ss][Vv][Cc][Pp]|[Vv][Cc][Rr][Uu][Nn][Tt][Ii][Mm][Ee])140[^/\\\\]*\\.dll$"
    POST_EXCLUDE_REGEXES "^/usr/lib/.*" "^/System/.*" ".*[Ss]ystem32/.*" ".*[Ss]ys[Ww][Oo][Ww]64/.*")
  if(unresolved)
    message(FATAL_ERROR "cpsat-runner: unresolved runtime dependencies: ${unresolved}")
  endif()
  foreach(dep IN LISTS resolved)
    file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/${RUNNER_LIB_DIR}"
      TYPE SHARED_LIBRARY FOLLOW_SYMLINK_CHAIN FILES "${dep}")
  endforeach()
]])
