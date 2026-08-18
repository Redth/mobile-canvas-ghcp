cmake_minimum_required(VERSION 3.21)

project(windows_app_helper LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "windows-app-helper can only be built on Windows.")
endif()

if(NOT MSVC)
  message(FATAL_ERROR "windows-app-helper requires the MSVC toolchain.")
endif()

enable_language(RC)

set(MOBILE_CANVAS_HELPER_VERSION "0.0.0-dev" CACHE STRING
    "Version reported by windows-app-helper capabilities")
set(MOBILE_CANVAS_HELPER_OUTPUT_DIR "" CACHE PATH
    "Directory to receive windows-app-helper.exe")

configure_file(
  "${CMAKE_CURRENT_SOURCE_DIR}/src/version.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/version.h"
  @ONLY)

add_executable(windows-app-helper
  src/main.cpp
  src/capture.cpp
  src/catalog.cpp
  src/encode.cpp
  src/support.cpp
  src/uia.cpp
  src/windows_enum.cpp
  windows-app-helper.rc)

target_compile_features(windows-app-helper PRIVATE cxx_std_17)
target_compile_definitions(windows-app-helper PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
  WINVER=0x0A00)
target_include_directories(windows-app-helper PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${CMAKE_CURRENT_BINARY_DIR}/generated")
target_compile_options(windows-app-helper PRIVATE
  /W4
  /permissive-
  /utf-8
  /EHsc)
set_property(TARGET windows-app-helper PROPERTY
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

target_link_libraries(windows-app-helper PRIVATE
  advapi32
  bcrypt
  d3d11
  dwmapi
  dxgi
  dxguid
  gdi32
  mf
  mfplat
  mfreadwrite
  mfuuid
  ole32
  oleaut32
  propsys
  runtimeobject
  shell32
  shlwapi
  strmiids
  uiautomationcore
  user32
  uuid
  windowscodecs
  wintrust)

# The resource script embeds the application manifest as resource 1. Disabling
# the linker's generated manifest avoids a second resource replacing the
# Per-Monitor DPI Aware v2 declaration on Visual Studio generators.
target_link_options(windows-app-helper PRIVATE
  "/MANIFEST:NO")

if(MOBILE_CANVAS_HELPER_OUTPUT_DIR)
  get_filename_component(helper_output_dir
    "${MOBILE_CANVAS_HELPER_OUTPUT_DIR}" ABSOLUTE)
  set_target_properties(windows-app-helper PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${helper_output_dir}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${helper_output_dir}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${helper_output_dir}"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${helper_output_dir}"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${helper_output_dir}")
endif()

include(CTest)
if(BUILD_TESTING)
  add_test(
    NAME windows-app-helper-capabilities-json
    COMMAND "${CMAKE_COMMAND}"
      "-DHELPER=$<TARGET_FILE:windows-app-helper>"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/capabilities-json.cmake")
  add_test(
    NAME windows-app-helper-invalid-arguments
    COMMAND "${CMAKE_COMMAND}"
      "-DHELPER=$<TARGET_FILE:windows-app-helper>"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/invalid-arguments.cmake")
  add_test(
    NAME windows-app-helper-catalog-json
    COMMAND "${CMAKE_COMMAND}"
      "-DHELPER=$<TARGET_FILE:windows-app-helper>"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/catalog-json.cmake")
  add_test(
    NAME windows-app-helper-windows-json
    COMMAND "${CMAKE_COMMAND}"
      "-DHELPER=$<TARGET_FILE:windows-app-helper>"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/windows-json.cmake")
  add_test(
    NAME windows-app-helper-launch-arguments
    COMMAND "${CMAKE_COMMAND}"
      "-DHELPER=$<TARGET_FILE:windows-app-helper>"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/launch-arguments.cmake")
  add_test(
    NAME windows-app-helper-uia-protocol-json
    COMMAND "${CMAKE_COMMAND}"
      "-DHELPER=$<TARGET_FILE:windows-app-helper>"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/uia-protocol-json.cmake")
  add_test(
    NAME windows-app-helper-uia-invalid-request
    COMMAND "${CMAKE_COMMAND}"
      "-DHELPER=$<TARGET_FILE:windows-app-helper>"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/uia-invalid-request.cmake")
  add_test(
    NAME windows-app-helper-capture-protocol-json
    COMMAND "${CMAKE_COMMAND}"
      "-DHELPER=$<TARGET_FILE:windows-app-helper>"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/capture-protocol-json.cmake")
  add_test(
    NAME windows-app-helper-capture-invalid-request
    COMMAND "${CMAKE_COMMAND}"
      "-DHELPER=$<TARGET_FILE:windows-app-helper>"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/capture-invalid-request.cmake")
endif()
