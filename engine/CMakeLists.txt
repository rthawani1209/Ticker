cmake_minimum_required(VERSION 3.20)
project(ticker_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

option(TICKER_BUILD_TESTS "Build unit tests" ON)
option(TICKER_BUILD_BENCH "Build benchmarks" ON)
set(TICKER_SANITIZE "" CACHE STRING "Sanitizers to enable, e.g. address,undefined or thread")

add_compile_options(-Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion)
if(TICKER_SANITIZE)
  add_compile_options(-fsanitize=${TICKER_SANITIZE} -fno-omit-frame-pointer)
  add_link_options(-fsanitize=${TICKER_SANITIZE})
endif()

find_package(Threads REQUIRED)

add_library(ticker_core
  src/engine.cpp
  src/journal.cpp
  src/order_book.cpp
  src/protocol.cpp
  src/types.cpp
)
target_include_directories(ticker_core PUBLIC include)

add_executable(ticker-replay tools/replay.cpp)
target_link_libraries(ticker-replay PRIVATE ticker_core)

if(TICKER_BUILD_TESTS)
  include(FetchContent)
  FetchContent_Declare(googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG v1.15.2
    GIT_SHALLOW TRUE)
  set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(googletest)

  enable_testing()
  add_executable(engine_tests
    tests/containers_test.cpp
    tests/differential_test.cpp
    tests/journal_test.cpp
    tests/order_book_test.cpp
    tests/protocol_test.cpp
    tests/spsc_ring_test.cpp
  )
  target_link_libraries(engine_tests PRIVATE ticker_core GTest::gtest_main Threads::Threads)
  include(GoogleTest)
  gtest_discover_tests(engine_tests DISCOVERY_TIMEOUT 60)

  add_executable(alloc_test tests/alloc_test.cpp)
  target_link_libraries(alloc_test PRIVATE ticker_core GTest::gtest_main)
  # Sanitizers replace operator new themselves, so this check only runs in normal builds.
  if(NOT TICKER_SANITIZE)
    gtest_discover_tests(alloc_test)
  endif()
endif()

if(TICKER_BUILD_BENCH)
  include(FetchContent)
  FetchContent_Declare(benchmark
    GIT_REPOSITORY https://github.com/google/benchmark.git
    GIT_TAG v1.9.1
    GIT_SHALLOW TRUE)
  set(BENCHMARK_ENABLE_TESTING OFF CACHE BOOL "" FORCE)
  set(BENCHMARK_ENABLE_GTEST_TESTS OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(benchmark)

  add_executable(book_bench bench/book_bench.cpp)
  target_include_directories(book_bench PRIVATE tests)
  target_link_libraries(book_bench PRIVATE ticker_core benchmark::benchmark)

  add_executable(latency bench/latency.cpp)
  target_include_directories(latency PRIVATE tests)
  target_link_libraries(latency PRIVATE ticker_core)
endif()
