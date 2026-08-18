if(NOT DEFINED HELPER)
  message(FATAL_ERROR "HELPER was not provided")
endif()

# launch never accepts a path, a command line, or a Shell verb. It takes one opaque catalog
# identifier, which the helper re-resolves against the live catalog. These cases prove the
# argument surface stays that narrow, without starting anything on the build agent.

function(expect_structured_failure expected_code)
  execute_process(
    COMMAND "${HELPER}" ${ARGN}
    RESULT_VARIABLE result
    OUTPUT_VARIABLE output
    ERROR_VARIABLE error)

  if(result EQUAL 0)
    message(FATAL_ERROR "'${ARGN}' unexpectedly succeeded")
  endif()
  if(NOT output STREQUAL "")
    message(FATAL_ERROR "'${ARGN}' wrote to stdout: ${output}")
  endif()

  string(JSON root_type ERROR_VARIABLE json_error TYPE "${error}")
  if(NOT "${json_error}" STREQUAL "NOTFOUND" OR NOT "${root_type}" STREQUAL "OBJECT")
    message(FATAL_ERROR "'${ARGN}' did not emit JSON stderr: ${json_error}")
  endif()

  string(JSON ok_value ERROR_VARIABLE ok_error GET "${error}" ok)
  if(NOT "${ok_error}" STREQUAL "NOTFOUND" OR ok_value)
    message(FATAL_ERROR "'${ARGN}' did not report ok=false: ${ok_error}")
  endif()

  string(JSON code ERROR_VARIABLE code_error GET "${error}" error code)
  if(NOT "${code_error}" STREQUAL "NOTFOUND" OR NOT "${code}" STREQUAL "${expected_code}")
    message(FATAL_ERROR "'${ARGN}' reported '${code}' rather than '${expected_code}'")
  endif()
endfunction()

expect_structured_failure(invalid_arguments launch --json)
expect_structured_failure(invalid_arguments launch --id)
expect_structured_failure(invalid_arguments launch --json --id --extra)
expect_structured_failure(invalid_arguments launch --id 0123456789abcdef)
expect_structured_failure(invalid_arguments launch --json --id "C:\\Windows\\System32\\cmd.exe")
expect_structured_failure(invalid_arguments launch --json --id "notepad")
expect_structured_failure(invalid_arguments launch --json --id "shell:AppsFolder\\x")
expect_structured_failure(unsupported_command launch-executable --json)

# A well-formed identifier that names nothing must be a lookup failure, not a launch.
expect_structured_failure(
  entry_not_found launch --json --id "00000000000000000000000000000000")
