if(NOT DEFINED HELPER)
  message(FATAL_ERROR "HELPER was not provided")
endif()

execute_process(
  COMMAND "${HELPER}" capabilities --json
  RESULT_VARIABLE result
  OUTPUT_VARIABLE output
  ERROR_VARIABLE error)

if(NOT result EQUAL 0)
  message(FATAL_ERROR "capabilities exited ${result}: ${error}")
endif()

if(NOT error STREQUAL "")
  message(FATAL_ERROR "capabilities wrote diagnostics on success: ${error}")
endif()

string(JSON root_type ERROR_VARIABLE json_error TYPE "${output}")
if(NOT "${json_error}" STREQUAL "NOTFOUND" OR NOT "${root_type}" STREQUAL "OBJECT")
  message(FATAL_ERROR "capabilities did not emit a JSON object: ${json_error}")
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
require_json_value(architecture)
require_json_value(os family)
require_json_value(os major)
require_json_value(os minor)
require_json_value(os build)
require_json_value(os nativeArchitecture)
require_json_value(session id)
require_json_value(session interactive)
require_json_value(session integrityLevel)
require_json_value(session integrityValue)

string(JSON schema_version ERROR_VARIABLE schema_error GET "${output}" schemaVersion)
if(NOT "${schema_error}" STREQUAL "NOTFOUND" OR NOT "${schema_version}" STREQUAL "1")
  message(FATAL_ERROR "unexpected capabilities schema version: ${schema_error} ${schema_version}")
endif()

string(JSON ok_value ERROR_VARIABLE ok_error GET "${output}" ok)
if(NOT "${ok_error}" STREQUAL "NOTFOUND" OR NOT ok_value)
  message(FATAL_ERROR "capabilities did not report ok=true: ${ok_error} ${ok_value}")
endif()

foreach(feature
    shellAppCatalog
    uiAutomation
    windowsGraphicsCapture
    mediaFoundationH264
    sendInput)
  require_json_value(features ${feature} available)
  require_json_value(features ${feature} hresult)
endforeach()

require_json_value(features windowsGraphicsCapture minimumBuild)
require_json_value(features windowsGraphicsCapture reportedBuild)
require_json_value(features authenticodeSignature valid)
require_json_value(features authenticodeSignature status)
require_json_value(features authenticodeSignature hresult)
