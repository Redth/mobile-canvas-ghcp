if(NOT DEFINED HELPER)
  message(FATAL_ERROR "HELPER is required.")
endif()

# Every capture request is strictly validated before a single Windows API is touched. These cases
# prove an unknown field, a wrong schema version, a missing body, and a bad handle are each refused
# with a framed error rather than tolerated.
function(expect_refused file_name command payload expected_code)
  set(request "${CMAKE_CURRENT_BINARY_DIR}/${file_name}")
  file(WRITE "${request}" "${payload}")
  execute_process(
    COMMAND "${HELPER}" "${command}" --json
    INPUT_FILE "${request}"
    RESULT_VARIABLE result
    OUTPUT_VARIABLE output
    ERROR_VARIABLE error)

  if(result EQUAL 0)
    message(FATAL_ERROR "${command} accepted an invalid request: ${output}")
  endif()
  string(FIND "${error}" "\"code\":\"${expected_code}\"" has_code)
  if(has_code EQUAL -1)
    message(FATAL_ERROR "${command} did not report ${expected_code}: ${error}")
  endif()
endfunction()

expect_refused(
  "capture-unknown-field.json"
  screenshot
  "{\"schemaVersion\":1,\"handle\":1,\"screenshot\":{\"scale\":1,\"unknown\":true}}"
  "capture_invalid_request")
expect_refused(
  "capture-wrong-schema.json"
  screenshot
  "{\"schemaVersion\":2,\"handle\":1,\"screenshot\":{\"scale\":1}}"
  "capture_schema_incompatible")
expect_refused(
  "capture-missing-body.json"
  capture
  "{\"schemaVersion\":1,\"handle\":1}"
  "capture_invalid_request")
expect_refused(
  "capture-bad-handle.json"
  capture
  "{\"schemaVersion\":1,\"handle\":0,\"capture\":{\"framesPerSecond\":30}}"
  "capture_invalid_request")
expect_refused(
  "capture-wrong-body.json"
  capture
  "{\"schemaVersion\":1,\"handle\":1,\"screenshot\":{\"scale\":1}}"
  "capture_invalid_request")

# A command with no request at all must say so rather than block forever on an empty pipe.
set(empty "${CMAKE_CURRENT_BINARY_DIR}/capture-empty.json")
file(WRITE "${empty}" "")
execute_process(
  COMMAND "${HELPER}" screenshot --json
  INPUT_FILE "${empty}"
  RESULT_VARIABLE empty_result
  ERROR_VARIABLE empty_error)
if(empty_result EQUAL 0)
  message(FATAL_ERROR "screenshot accepted an empty request.")
endif()
string(FIND "${empty_error}" "\"code\":\"capture_invalid_request\"" has_empty_code)
if(has_empty_code EQUAL -1)
  message(FATAL_ERROR "screenshot did not refuse an empty request: ${empty_error}")
endif()

# Options are exact: capture and screenshot each take --json and nothing else.
foreach(command IN ITEMS screenshot capture)
  execute_process(
    COMMAND "${HELPER}" "${command}" --json --extra
    RESULT_VARIABLE option_result
    ERROR_VARIABLE option_error)
  if(option_result EQUAL 0)
    message(FATAL_ERROR "${command} accepted an unknown option.")
  endif()
  string(FIND "${option_error}" "\"code\":\"invalid_arguments\"" has_option_code)
  if(has_option_code EQUAL -1)
    message(FATAL_ERROR "${command} did not refuse an unknown option: ${option_error}")
  endif()
endforeach()
