if(NOT DEFINED HELPER)
  message(FATAL_ERROR "HELPER is required.")
endif()

# Handle 1 is deliberately not a window. That lets this protocol test run on CI without an
# interactive desktop while still proving both capture commands frame a versioned status line on
# standard error, keep standard output free of JSON, and report a machine-readable capture status.
function(run_capture command file_name payload expected_status)
  set(request "${CMAKE_CURRENT_BINARY_DIR}/${file_name}")
  file(WRITE "${request}" "${payload}")
  execute_process(
    COMMAND "${HELPER}" "${command}" --json
    INPUT_FILE "${request}"
    RESULT_VARIABLE result
    OUTPUT_VARIABLE output
    ERROR_VARIABLE error)

  if(result EQUAL 0)
    message(FATAL_ERROR "${command} claimed to capture a window that does not exist: ${error}")
  endif()

  string(FIND "${error}" "\"schemaVersion\":1" has_schema)
  string(FIND "${error}" "\"ok\":false" has_failed)
  string(FIND "${error}" "\"type\":\"descriptor\"" has_type)
  string(FIND "${error}" "\"status\":\"${expected_status}\"" has_status)
  if(has_schema EQUAL -1 OR has_failed EQUAL -1 OR has_type EQUAL -1 OR has_status EQUAL -1)
    message(FATAL_ERROR "Unexpected ${command} status line: ${error}")
  endif()

  # Standard output carries image or Annex-B bytes only. A JSON brace there would mean the two
  # streams had been mixed, which is the one framing mistake this protocol cannot tolerate.
  string(FIND "${output}" "{" mixed_streams)
  if(NOT mixed_streams EQUAL -1)
    message(FATAL_ERROR "${command} wrote JSON to standard output: ${output}")
  endif()
endfunction()

run_capture(
  screenshot
  "screenshot-request.json"
  "{\"schemaVersion\":1,\"handle\":1,\"screenshot\":{\"scale\":1,\"maximumDimension\":0,\"includeCursor\":false,\"timeoutMilliseconds\":2000}}"
  "closed")
run_capture(
  capture
  "capture-request.json"
  "{\"schemaVersion\":1,\"handle\":1,\"capture\":{\"framesPerSecond\":30,\"scale\":1,\"averageBitrate\":8000000,\"includeCursor\":false,\"timeoutMilliseconds\":2000}}"
  "closed")
