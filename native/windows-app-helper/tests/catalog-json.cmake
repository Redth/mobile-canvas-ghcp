if(NOT DEFINED HELPER)
  message(FATAL_ERROR "HELPER was not provided")
endif()

execute_process(
  COMMAND "${HELPER}" catalog --json
  RESULT_VARIABLE result
  OUTPUT_VARIABLE output
  ERROR_VARIABLE error)

if(NOT result EQUAL 0)
  message(FATAL_ERROR "catalog exited ${result}: ${error}")
endif()

if(NOT error STREQUAL "")
  message(FATAL_ERROR "catalog wrote diagnostics on success: ${error}")
endif()

string(JSON root_type ERROR_VARIABLE json_error TYPE "${output}")
if(NOT "${json_error}" STREQUAL "NOTFOUND" OR NOT "${root_type}" STREQUAL "OBJECT")
  message(FATAL_ERROR "catalog did not emit a JSON object: ${json_error}")
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
require_json_value(sources)
require_json_value(entries)

string(JSON schema_version GET "${output}" schemaVersion)
if(NOT "${schema_version}" STREQUAL "1")
  message(FATAL_ERROR "unexpected catalog schema version: ${schema_version}")
endif()

string(JSON ok_value GET "${output}" ok)
if(NOT ok_value)
  message(FATAL_ERROR "catalog did not report ok=true")
endif()

# Every source has to answer, including the ones that could not read anything. A missing source is
# how "this app is not installed" gets confused with "the catalog was incomplete".
string(JSON source_count ERROR_VARIABLE length_error LENGTH "${output}" sources)
if(NOT "${length_error}" STREQUAL "NOTFOUND" OR source_count LESS 3)
  message(FATAL_ERROR "catalog reported ${source_count} sources: ${length_error}")
endif()

set(expected_sources appsFolder startMenuShortcuts appPaths)
math(EXPR last_source "${source_count} - 1")
set(seen_sources "")
foreach(index RANGE ${last_source})
  string(JSON source GET "${output}" sources ${index})
  string(JSON name GET "${source}" name)
  string(JSON supported GET "${source}" supported)
  string(JSON count GET "${source}" count)
  string(JSON hresult GET "${source}" hresult)
  list(APPEND seen_sources "${name}")
endforeach()

foreach(expected IN LISTS expected_sources)
  if(NOT "${expected}" IN_LIST seen_sources)
    message(FATAL_ERROR "catalog did not report the ${expected} source")
  endif()
endforeach()

string(JSON entry_count LENGTH "${output}" entries)
if(entry_count EQUAL 0)
  message(FATAL_ERROR "catalog reported no launchable apps on a desktop Windows image")
endif()

# Identifiers must be stable, opaque, and unique: the host launches by identifier, so a duplicate
# or a name-derived identifier would launch the wrong app.
math(EXPR last_entry "${entry_count} - 1")
set(seen_ids "")
foreach(index RANGE ${last_entry})
  string(JSON entry GET "${output}" entries ${index})
  string(JSON id GET "${entry}" id)
  string(JSON display_name GET "${entry}" displayName)
  string(JSON source GET "${entry}" source)
  string(JSON kind GET "${entry}" kind)
  string(JSON launch_method GET "${entry}" launchMethod)

  if(id STREQUAL "")
    message(FATAL_ERROR "catalog entry ${index} has an empty id")
  endif()
  if(NOT id MATCHES "^[0-9a-f]+$")
    message(FATAL_ERROR "catalog entry ${index} has a non-opaque id: ${id}")
  endif()
  if("${id}" IN_LIST seen_ids)
    message(FATAL_ERROR "catalog repeated entry id ${id}")
  endif()
  if(NOT kind MATCHES "^(packaged|desktop)$")
    message(FATAL_ERROR "catalog entry ${index} has an unknown kind: ${kind}")
  endif()
  if(NOT launch_method MATCHES "^(shellItem|shortcut|executable)$")
    message(FATAL_ERROR "catalog entry ${index} has an unknown launch method: ${launch_method}")
  endif()
  list(APPEND seen_ids "${id}")
endforeach()

# Running it twice must produce the same identifiers, because the host stores them.
execute_process(
  COMMAND "${HELPER}" catalog --json
  RESULT_VARIABLE second_result
  OUTPUT_VARIABLE second_output
  ERROR_VARIABLE second_error)
if(NOT second_result EQUAL 0)
  message(FATAL_ERROR "second catalog run exited ${second_result}: ${second_error}")
endif()

string(JSON second_count LENGTH "${second_output}" entries)
math(EXPR last_second "${second_count} - 1")
set(second_ids "")
foreach(index RANGE ${last_second})
  string(JSON entry GET "${second_output}" entries ${index})
  string(JSON id GET "${entry}" id)
  list(APPEND second_ids "${id}")
endforeach()

foreach(id IN LISTS seen_ids)
  if(NOT "${id}" IN_LIST second_ids)
    message(FATAL_ERROR "catalog identifier ${id} was not stable across runs")
  endif()
endforeach()
