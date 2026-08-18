if(NOT DEFINED HELPER)
  message(FATAL_ERROR "HELPER is required.")
endif()

set(request "${CMAKE_CURRENT_BINARY_DIR}/uia-invalid-request.json")
file(WRITE "${request}" "{\"schemaVersion\":1,\"handle\":1,\"request\":{\"maximumDepth\":2,\"unknown\":true}}")
execute_process(
  COMMAND "${HELPER}" uia-snapshot --json
  INPUT_FILE "${request}"
  RESULT_VARIABLE result
  OUTPUT_VARIABLE output
  ERROR_VARIABLE error)

if(result EQUAL 0)
  message(FATAL_ERROR "uia-snapshot accepted an unknown request field: ${output}")
endif()
string(FIND "${error}" "\"schemaVersion\":1" has_schema)
string(FIND "${error}" "\"ok\":false" has_failed)
string(FIND "${error}" "\"code\":\"uia_invalid_request\"" has_code)
if(has_schema EQUAL -1 OR has_failed EQUAL -1 OR has_code EQUAL -1)
  message(FATAL_ERROR "uia-snapshot did not return a structured request error: ${error}")
endif()
