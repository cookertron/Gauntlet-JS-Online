# gauntlet-relay -- the lockstep relay (see shared/PROTOCOL.md).
# Build (toolchain notes in CLAUDE.md -- run inside vcvars64):
#   cmake -S server -B server/build -G Ninja
#   ninja -C server/build
cmake_minimum_required(VERSION 3.20)
project(gauntlet_relay CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_executable(gauntlet-relay relay.cpp gui.cpp)
target_link_libraries(gauntlet-relay ws2_32 iphlpapi user32 gdi32 comctl32 shell32)
if(MSVC)
  target_compile_options(gauntlet-relay PRIVATE /W4 /permissive-)
  target_compile_definitions(gauntlet-relay PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()
