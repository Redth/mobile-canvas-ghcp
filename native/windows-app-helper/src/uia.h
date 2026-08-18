#pragma once

#include <string>
#include <string_view>

namespace helper {

// Each command receives exactly one versioned JSON request through stdin and emits one versioned
// JSON response. The raw HWND lives only in these private helper requests; public callers use the
// host's opaque window capability instead.
std::string UiaSnapshotJson(std::string_view request_json);
std::string UiaFindJson(std::string_view request_json);
std::string UiaActionJson(std::string_view request_json);
std::string UiaWaitJson(std::string_view request_json);

} // namespace helper
