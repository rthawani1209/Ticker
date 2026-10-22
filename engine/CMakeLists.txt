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
set(TICKER_SANITIZE "" CACHE STRING "Sanitizers to enable, e.g. address,undefined or thread")

add_compile_options(-Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion)
if(TICKER_SANITIZE)
  add_compile_options(-fsanitize=${TICKER_SANITIZE} -fno-omit-frame-pointer)
  add_link_options(-fsanitize=${TICKER_SANITIZE})
endif()

add_library(ticker_core INTERFACE)
target_include_directories(ticker_core INTERFACE include)

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
  )
  target_link_libraries(engine_tests PRIVATE ticker_core GTest::gtest_main)
  include(GoogleTest)
  gtest_discover_tests(engine_tests DISCOVERY_TIMEOUT 60)
endif()
