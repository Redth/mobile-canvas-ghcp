if(NOT DEFINED HELPER)
  message(FATAL_ERROR "HELPER was not provided")
endif()

execute_process(
  COMMAND "${HELPER}" windows --json
  RESULT_VARIABLE result
  OUTPUT_VARIABLE output
  ERROR_VARIABLE error)

if(NOT result EQUAL 0)
  message(FATAL_ERROR "windows exited ${result}: ${error}")
endif()

if(NOT error STREQUAL "")
  message(FATAL_ERROR "windows wrote diagnostics on success: ${error}")
endif()

string(JSON root_type ERROR_VARIABLE json_error TYPE "${output}")
if(NOT "${json_error}" STREQUAL "NOTFOUND" OR NOT "${root_type}" STREQUAL "OBJECT")
  message(FATAL_ERROR "windows did not emit a JSON object: ${json_error}")
endif()

function(require_json_value)
  string(JSON ignored ERROR_VARIABLE value_error GET "${output}" ${ARGV})
  if(NOT "${value_error}" STREQUAL "NOTFOUND")
    message(FATAL_ERROR "missing JSON value ${ARGV}: ${value_error}")
  endif()
endfunction()

require_json_value(schemaVersion)
require_json_value(ok)
require_json_value(helperVersion)
require_json_value(truncated)
require_json_value(windows)
require_json_value(session id)
require_json_value(session interactive)
require_json_value(session integrityLevel)
require_json_value(session integrityValue)

string(JSON schema_version GET "${output}" schemaVersion)
if(NOT "${schema_version}" STREQUAL "1")
  message(FATAL_ERROR "unexpected windows schema version: ${schema_version}")
endif()

string(JSON ok_value GET "${output}" ok)
if(NOT ok_value)
  message(FATAL_ERROR "windows did not report ok=true")
endif()

string(JSON window_count LENGTH "${output}" windows)
if(window_count EQUAL 0)
  # A hosted agent can run without a visible desktop window, so an empty list is a valid state.
  # What must never happen is an empty list that also claims an interactive session it cannot see.
  return()
endif()

math(EXPR last_window "${window_count} - 1")
set(seen_handles "")
foreach(index RANGE ${last_window})
  string(JSON window GET "${output}" windows ${index})
  foreach(field
      handle
      processId
      processStartFileTime
      sessionId
      title
      className
      visible
      minimized
      cloaked
      toolWindow
      ownerHandle
      integrityLevel
      integrityValue
      elevated
      identityAccess)
    string(JSON value ERROR_VARIABLE field_error GET "${window}" ${field})
    if(NOT "${field_error}" STREQUAL "NOTFOUND")
      message(FATAL_ERROR "window ${index} is missing ${field}: ${field_error}")
    endif()
  endforeach()

  foreach(field left top width height)
    string(JSON value ERROR_VARIABLE bounds_error GET "${window}" bounds ${field})
    if(NOT "${bounds_error}" STREQUAL "NOTFOUND")
      message(FATAL_ERROR "window ${index} is missing bounds.${field}: ${bounds_error}")
    endif()
  endforeach()

  string(JSON handle GET "${window}" handle)
  if(handle EQUAL 0)
    message(FATAL_ERROR "window ${index} reported a null handle")
  endif()
  if("${handle}" IN_LIST seen_handles)
    message(FATAL_ERROR "windows repeated handle ${handle}")
  endif()
  list(APPEND seen_handles "${handle}")

  string(JSON access GET "${window}" identityAccess)
  if(NOT access MATCHES "^(full|limited|denied)$")
    message(FATAL_ERROR "window ${index} reported an unknown identityAccess: ${access}")
  endif()

  string(JSON integrity GET "${window}" integrityLevel)
  if(NOT integrity MATCHES "^(unknown|untrusted|low|medium|high|system)$")
    message(FATAL_ERROR "window ${index} reported an unknown integrity level: ${integrity}")
  endif()
endforeach()
