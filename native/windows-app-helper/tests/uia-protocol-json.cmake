if(NOT DEFINED HELPER)
  message(FATAL_ERROR "HELPER is required.")
endif()

function(run_uia command file_name payload required_text)
  set(request "${CMAKE_CURRENT_BINARY_DIR}/${file_name}")
  file(WRITE "${request}" "${payload}")
  execute_process(
    COMMAND "${HELPER}" "${command}" --json
    INPUT_FILE "${request}"
    RESULT_VARIABLE result
    OUTPUT_VARIABLE output
    ERROR_VARIABLE error)
  if(NOT result EQUAL 0)
    message(FATAL_ERROR "${command} failed (${result}): ${error}")
  endif()
  string(FIND "${output}" "\"schemaVersion\":1" has_schema)
  string(FIND "${output}" "\"ok\":true" has_ok)
  string(FIND "${output}" "\"result\":" has_result)
  string(FIND "${output}" "${required_text}" has_required)
  if(has_schema EQUAL -1 OR has_ok EQUAL -1 OR has_result EQUAL -1 OR has_required EQUAL -1)
    message(FATAL_ERROR "Unexpected ${command} payload: ${output}")
  endif()
  # Raw HWNDs are helper inputs only; a response must never echo this test's handle.
  string(FIND "${output}" "\"handle\":1" leaked_handle)
  if(NOT leaked_handle EQUAL -1)
    message(FATAL_ERROR "${command} leaked its raw HWND: ${output}")
  endif()
endfunction()

# Handle 1 is deliberately invalid. That lets this protocol test run on CI without an interactive
# desktop while still proving each strict, versioned stdin command returns one framed result.
run_uia(
  uia-snapshot
  "uia-snapshot-request.json"
  "{\"schemaVersion\":1,\"handle\":1,\"request\":{\"maximumDepth\":2,\"maximumNodes\":5,\"timeoutMilliseconds\":1000}}"
  "\"metadata\":")
run_uia(
  uia-find
  "uia-find-request.json"
  "{\"schemaVersion\":1,\"handle\":1,\"query\":{\"selector\":{\"automationId\":\"save\",\"controlType\":\"button\"},\"limit\":5,\"maximumDepth\":2,\"maximumNodes\":5,\"timeoutMilliseconds\":1000}}"
  "\"totalMatches\":0")
run_uia(
  uia-find
  "uia-find-ancestor-request.json"
  "{\"schemaVersion\":1,\"handle\":1,\"query\":{\"selector\":{\"controlType\":\"button\",\"name\":\"Save\",\"ancestors\":[{\"controlType\":\"window\",\"name\":\"Editor\",\"exact\":true,\"ancestors\":[],\"path\":[]}],\"path\":[],\"exact\":true},\"limit\":5,\"maximumDepth\":2,\"maximumNodes\":5,\"timeoutMilliseconds\":1000}}"
  "\"totalMatches\":0")
run_uia(
  uia-action
  "uia-action-request.json"
  "{\"schemaVersion\":1,\"handle\":1,\"request\":{\"action\":\"invoke\",\"selector\":{\"automationId\":\"save\",\"controlType\":\"button\"},\"maximumDepth\":2,\"maximumNodes\":5,\"timeoutMilliseconds\":1000}}"
  "\"windows_uia_element_not_found\"")
foreach(action IN ITEMS setValue select toggle expand collapse focus)
  if(action STREQUAL "setValue")
    set(extra ",\"value\":\"draft\"")
  else()
    set(extra "")
  endif()
  run_uia(
    uia-action
    "uia-action-${action}-request.json"
    "{\"schemaVersion\":1,\"handle\":1,\"request\":{\"action\":\"${action}\",\"selector\":{\"automationId\":\"save\",\"controlType\":\"button\"}${extra},\"maximumDepth\":2,\"maximumNodes\":5,\"timeoutMilliseconds\":1000}}"
    "\"windows_uia_element_not_found\"")
endforeach()
run_uia(
  uia-action
  "uia-action-scroll-request.json"
  "{\"schemaVersion\":1,\"handle\":1,\"request\":{\"action\":\"scroll\",\"selector\":{\"automationId\":\"save\",\"controlType\":\"button\"},\"scroll\":{\"direction\":\"down\",\"amount\":\"small\"},\"maximumDepth\":2,\"maximumNodes\":5,\"timeoutMilliseconds\":1000}}"
  "\"windows_uia_element_not_found\"")
run_uia(
  uia-wait
  "uia-wait-request.json"
  "{\"schemaVersion\":1,\"handle\":1,\"request\":{\"selector\":{\"automationId\":\"save\",\"controlType\":\"button\"},\"condition\":\"notExists\",\"timeoutMilliseconds\":1000,\"pollIntervalMilliseconds\":50,\"maximumDepth\":2,\"maximumNodes\":5}}"
  "\"satisfied\":true")
