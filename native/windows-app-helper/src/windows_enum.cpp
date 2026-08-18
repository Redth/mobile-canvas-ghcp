#include "windows_enum.h"
#include "version.h"

#include <appmodel.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <propkey.h>
#include <propsys.h>
#include <propvarutil.h>

namespace helper {
namespace {

/// A desktop with more top-level windows than this is pathological, and the host must be able to
/// trust that one enumeration cannot grow without bound.
constexpr size_t kMaximumWindows = 2000;

std::wstring WindowTitle(HWND window) {
	const int length = GetWindowTextLengthW(window);
	if (length <= 0) {
		return {};
	}
	std::vector<wchar_t> buffer(static_cast<size_t>(length) + 1, L'\0');
	const int copied = GetWindowTextW(window, buffer.data(), static_cast<int>(buffer.size()));
	return copied <= 0 ? std::wstring() : std::wstring(buffer.data(), static_cast<size_t>(copied));
}

std::wstring WindowClass(HWND window) {
	wchar_t buffer[256] = {};
	const int copied = GetClassNameW(window, buffer, ARRAYSIZE(buffer));
	return copied <= 0 ? std::wstring() : std::wstring(buffer, static_cast<size_t>(copied));
}

bool IsCloaked(HWND window) {
	DWORD cloaked = 0;
	if (FAILED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked)))) {
		return false;
	}
	return cloaked != 0;
}

RECT WindowBounds(HWND window) {
	RECT bounds = {};
	// The DWM frame is what the user sees; GetWindowRect includes the invisible resize border on
	// modern themes, which would make a capture rectangle wrong by several pixels.
	if (SUCCEEDED(DwmGetWindowAttribute(
			window, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds)))) {
		return bounds;
	}
	GetWindowRect(window, &bounds);
	return bounds;
}

std::uint64_t ProcessStartFileTime(HANDLE process) {
	FILETIME creation = {};
	FILETIME exited = {};
	FILETIME kernel = {};
	FILETIME user = {};
	if (!GetProcessTimes(process, &creation, &exited, &kernel, &user)) {
		return 0;
	}
	return (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32)
		| static_cast<std::uint64_t>(creation.dwLowDateTime);
}

std::wstring ProcessPath(HANDLE process) {
	std::vector<wchar_t> buffer(MAX_PATH * 2, L'\0');
	DWORD size = static_cast<DWORD>(buffer.size());
	if (!QueryFullProcessImageNameW(process, 0, buffer.data(), &size)) {
		return {};
	}
	return std::wstring(buffer.data(), size);
}

std::wstring ApplicationUserModelId(HANDLE process) {
	UINT32 length = 0;
	if (GetApplicationUserModelId(process, &length, nullptr) != ERROR_INSUFFICIENT_BUFFER
		|| length == 0) {
		return {};
	}
	std::vector<wchar_t> buffer(length, L'\0');
	if (GetApplicationUserModelId(process, &length, buffer.data()) != ERROR_SUCCESS) {
		return {};
	}
	return std::wstring(buffer.data());
}

std::wstring PackageFamily(HANDLE process) {
	UINT32 length = 0;
	if (GetPackageFamilyName(process, &length, nullptr) != ERROR_INSUFFICIENT_BUFFER
		|| length == 0) {
		return {};
	}
	std::vector<wchar_t> buffer(length, L'\0');
	if (GetPackageFamilyName(process, &length, buffer.data()) != ERROR_SUCCESS) {
		return {};
	}
	return std::wstring(buffer.data());
}

std::wstring PackageFullName(HANDLE process) {
	UINT32 length = 0;
	if (GetPackageFullName(process, &length, nullptr) != ERROR_INSUFFICIENT_BUFFER
		|| length == 0) {
		return {};
	}
	std::vector<wchar_t> buffer(length, L'\0');
	if (GetPackageFullName(process, &length, buffer.data()) != ERROR_SUCCESS) {
		return {};
	}
	return std::wstring(buffer.data());
}

/// A packaged app's frame is hosted by ApplicationFrameHost, whose own process identity says
/// nothing about which app is inside it. The window's own AppUserModelID property does, so it is
/// read from the window rather than inferred from the process.
std::wstring WindowAumid(HWND window) {
	ComPtr<IPropertyStore> store;
	if (FAILED(SHGetPropertyStoreForWindow(
			window, __uuidof(IPropertyStore), reinterpret_cast<void**>(store.Put())))) {
		return {};
	}

	PROPVARIANT value;
	PropVariantInit(&value);
	if (FAILED(store->GetValue(PKEY_AppUserModel_ID, &value))) {
		PropVariantClear(&value);
		return {};
	}

	std::wstring result;
	if (value.vt == VT_LPWSTR && value.pwszVal != nullptr) {
		result = value.pwszVal;
	}
	PropVariantClear(&value);
	return result;
}

void Describe(WindowInfo& info) {
	HANDLE process = OpenProcess(
		PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(info.process_id));
	if (process == nullptr) {
		info.identity_access = "denied";
		info.integrity.level = "unknown";
		return;
	}

	info.process_start_file_time = ProcessStartFileTime(process);
	info.process_path = ProcessPath(process);
	info.aumid = ApplicationUserModelId(process);
	info.package_family = PackageFamily(process);
	info.package_full_name = PackageFullName(process);
	info.integrity = QueryIntegrity(process);
	CloseHandle(process);

	// A window whose own AppUserModelID differs from its host process's identity is the packaged
	// case, and the window's value is the one that names the app. The property store is only
	// consulted when the process itself has no packaged identity, which keeps this off the fast
	// path for apps that already answered and avoids a cross-process call per window.
	if (info.aumid.empty()) {
		const std::wstring window_aumid = WindowAumid(reinterpret_cast<HWND>(info.handle));
		if (!window_aumid.empty()) {
			info.aumid = window_aumid;
			const auto separator = window_aumid.find(L'!');
			if (separator != std::wstring::npos) {
				info.package_family = window_aumid.substr(0, separator);
			}
		}
	}

	info.identity_access =
		(info.process_start_file_time != 0 && !info.process_path.empty() && info.integrity.known)
			? "full"
			: "limited";
}

BOOL CALLBACK Collect(HWND window, LPARAM parameter) {
	auto* list = reinterpret_cast<WindowList*>(parameter);
	if (list->windows.size() >= kMaximumWindows) {
		list->truncated = true;
		return FALSE;
	}

	WindowInfo info;
	info.handle = reinterpret_cast<std::uint64_t>(window);
	DWORD process_id = 0;
	GetWindowThreadProcessId(window, &process_id);
	info.process_id = process_id;
	if (process_id == 0) {
		return TRUE;
	}

	DWORD session_id = 0;
	if (ProcessIdToSessionId(process_id, &session_id)) {
		info.session_id = session_id;
	}

	info.title = WindowTitle(window);
	info.class_name = WindowClass(window);
	info.bounds = WindowBounds(window);
	info.visible = IsWindowVisible(window) != FALSE;
	info.minimized = IsIconic(window) != FALSE;
	info.cloaked = IsCloaked(window);
	info.tool_window =
		(GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0;
	info.owner_handle = reinterpret_cast<std::uint64_t>(GetWindow(window, GW_OWNER));

	Describe(info);
	list->windows.push_back(std::move(info));
	return TRUE;
}

std::string BoundsJson(const RECT& bounds) {
	JsonObject object;
	object.Signed("left", bounds.left);
	object.Signed("top", bounds.top);
	object.Signed("width", static_cast<std::int64_t>(bounds.right) - bounds.left);
	object.Signed("height", static_cast<std::int64_t>(bounds.bottom) - bounds.top);
	return object.Finish();
}

std::string WindowJson(const WindowInfo& info, const SessionInfo& session) {
	JsonObject object;
	object.Number("handle", info.handle);
	object.Number("processId", info.process_id);
	object.Number("processStartFileTime", info.process_start_file_time);
	object.Number("sessionId", info.session_id);
	object.String("title", Utf8(info.title));
	object.String("className", Utf8(info.class_name));
	object.Raw("bounds", BoundsJson(info.bounds));
	object.Boolean("visible", info.visible);
	object.Boolean("minimized", info.minimized);
	object.Boolean("cloaked", info.cloaked);
	object.Boolean("toolWindow", info.tool_window);
	object.Number("ownerHandle", info.owner_handle);
	object.OptionalString("processPath", info.process_path);
	object.OptionalString("appUserModelId", info.aumid);
	object.OptionalString("packageFamilyName", info.package_family);
	object.OptionalString("packageFullName", info.package_full_name);
	object.String("integrityLevel", info.integrity.level);
	object.Number("integrityValue", info.integrity.value);
	// Elevated relative to this helper, which is the only comparison that decides whether Windows
	// would let automation reach the window at all.
	object.Boolean(
		"elevated",
		info.integrity.known && session.integrity.known
			? info.integrity.value > session.integrity.value
			: info.integrity.elevated && !session.integrity.elevated);
	object.String("identityAccess", info.identity_access);
	return object.Finish();
}

} // namespace

WindowList EnumerateWindows() {
	WindowList list;
	list.session = CurrentSession();
	EnumWindows(Collect, reinterpret_cast<LPARAM>(&list));
	return list;
}

std::string WindowListJson(const WindowList& list) {
	JsonArray windows;
	for (const auto& window : list.windows) {
		windows.Raw(WindowJson(window, list.session));
	}

	JsonObject root;
	root.Number("schemaVersion", 1);
	root.Boolean("ok", true);
	root.String("helperVersion", Utf8(MOBILE_CANVAS_HELPER_VERSION));
	root.Boolean("truncated", list.truncated);
	root.Raw("session", SessionJson(list.session));
	root.Raw("windows", windows.Finish());
	return root.Finish();
}

} // namespace helper
