if(NOT DEFINED HELPER)
  message(FATAL_ERROR "HELPER was not provided")
endif()

execute_process(
  COMMAND "${HELPER}" capabilities
  RESULT_VARIABLE result
  OUTPUT_VARIABLE output
  ERROR_VARIABLE error)

if(result EQUAL 0)
  message(FATAL_ERROR "capabilities without --json unexpectedly succeeded")
endif()

if(NOT output STREQUAL "")
  message(FATAL_ERROR "invalid invocation wrote to stdout: ${output}")
endif()

string(JSON root_type ERROR_VARIABLE json_error TYPE "${error}")
if(NOT "${json_error}" STREQUAL "NOTFOUND" OR NOT "${root_type}" STREQUAL "OBJECT")
  message(FATAL_ERROR "invalid invocation did not emit JSON stderr: ${json_error}")
endif()

string(JSON ok_value ERROR_VARIABLE ok_error GET "${error}" ok)
if(NOT "${ok_error}" STREQUAL "NOTFOUND" OR ok_value)
  message(FATAL_ERROR "invalid invocation did not report ok=false: ${ok_error} ${ok_value}")
endif()

string(JSON code ERROR_VARIABLE code_error GET "${error}" error code)
if(NOT "${code_error}" STREQUAL "NOTFOUND" OR NOT "${code}" STREQUAL "invalid_arguments")
  message(FATAL_ERROR "unexpected structured error code: ${code_error} ${code}")
endif()
