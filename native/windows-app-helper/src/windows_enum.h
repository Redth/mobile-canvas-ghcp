#pragma once

#include "support.h"

#include <string>
#include <vector>

namespace helper {

/// One visible top-level window, with everything the host needs to prove whose it is before it
/// authorizes anything. The raw handle is reported because the host stores it as part of a
/// window's identity; it is never something a caller may supply.
struct WindowInfo {
	std::uint64_t handle = 0;
	std::uint32_t process_id = 0;
	std::uint64_t process_start_file_time = 0;
	std::uint32_t session_id = 0;
	std::wstring title;
	std::wstring class_name;
	RECT bounds = {};
	bool visible = false;
	bool minimized = false;
	bool cloaked = false;
	bool tool_window = false;
	std::uint64_t owner_handle = 0;
	std::wstring process_path;
	std::wstring aumid;
	std::wstring package_family;
	std::wstring package_full_name;
	IntegrityInfo integrity;
	std::string identity_access;
};

struct WindowList {
	std::vector<WindowInfo> windows;
	SessionInfo session;
	bool truncated = false;
};

WindowList EnumerateWindows();
std::string WindowListJson(const WindowList& list);

} // namespace helper
