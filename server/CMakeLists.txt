# gauntlet-relay -- the lockstep relay and its window (see shared/PROTOCOL.md).
# Build (toolchain notes in CLAUDE.md -- run inside vcvars64):
#   cmake -S server -B server/build -G Ninja
#   ninja -C server/build
cmake_minimum_required(VERSION 3.20)
project(gauntlet_relay CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# THE SHIPPED EXE IS A RELEASE BUILD WITH THE STATIC RUNTIME.  A Debug
# build links the debug CRT DLLs (ucrtbased, VCRUNTIME140D, MSVCP140D,
# VCRUNTIME140_1D), which exist only where Visual Studio is installed --
# Anthony found that on a second machine, 2026-09-05.  /MT folds the
# runtime into the exe, so it depends on nothing but Windows itself.
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Release unless asked otherwise" FORCE)
endif()
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  message(WARNING "Debug build: the exe will need the debug CRT DLLs, which only a machine with Visual Studio has -- do not ship it (tools/package.py refuses to)")
endif()
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_executable(gauntlet-relay relay.cpp gui.cpp)
target_link_libraries(gauntlet-relay ws2_32 iphlpapi user32 gdi32 comctl32 shell32)
if(MSVC)
  target_compile_options(gauntlet-relay PRIVATE /W4 /permissive-)
  target_compile_definitions(gauntlet-relay PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()
