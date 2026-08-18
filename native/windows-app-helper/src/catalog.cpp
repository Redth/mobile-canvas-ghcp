#include "catalog.h"
#include "version.h"

#include <shlobj.h>
#include <shellapi.h>
#include <propkey.h>
#include <knownfolders.h>

#include <algorithm>
#include <cwctype>
#include <set>

namespace helper {
namespace {

/// A machine with more launchable apps than this has something wrong with it, and the host has to
/// be able to trust that one enumeration cannot grow without bound.
constexpr size_t kMaximumEntries = 5000;
constexpr int kMaximumShortcutDepth = 6;

constexpr wchar_t kAppPathsKey[] =
	L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths";

std::wstring Lowercase(std::wstring_view value) {
	std::wstring result(value);
	std::transform(result.begin(), result.end(), result.begin(), [](wchar_t character) {
		return static_cast<wchar_t>(std::towlower(character));
	});
	return result;
}

bool EndsWithExe(std::wstring_view value) {
	if (value.size() < 4) {
		return false;
	}
	return Lowercase(value.substr(value.size() - 4)) == L".exe";
}

std::wstring Expand(std::wstring_view value) {
	if (value.empty()) {
		return {};
	}
	std::wstring input(value);
	std::vector<wchar_t> buffer(MAX_PATH * 2);
	const DWORD needed = ExpandEnvironmentStringsW(
		input.c_str(), buffer.data(), static_cast<DWORD>(buffer.size()));
	if (needed == 0) {
		return input;
	}
	if (needed > buffer.size()) {
		buffer.resize(needed);
		if (ExpandEnvironmentStringsW(
				input.c_str(), buffer.data(), static_cast<DWORD>(buffer.size()))
			== 0) {
			return input;
		}
	}
	return std::wstring(buffer.data());
}

std::wstring Unquote(std::wstring_view value) {
	if (value.size() >= 2 && value.front() == L'"' && value.back() == L'"') {
		return std::wstring(value.substr(1, value.size() - 2));
	}
	return std::wstring(value);
}

/// What makes two rows from the same source the same app.
std::wstring CanonicalKey(const CatalogEntry& entry) {
	if (!entry.aumid.empty()) {
		return L"aumid:" + Lowercase(entry.aumid);
	}
	if (!entry.executable_path.empty()) {
		return L"exe:" + Lowercase(entry.executable_path) + L"|" + Lowercase(entry.arguments);
	}
	if (!entry.parsing_name.empty()) {
		return L"parsing:" + Lowercase(entry.parsing_name);
	}
	return L"shortcut:" + Lowercase(entry.shortcut_path);
}

std::wstring FileNameWithoutExtension(std::wstring_view path) {
	const auto slash = path.find_last_of(L"\\/");
	const auto name = slash == std::wstring_view::npos ? path : path.substr(slash + 1);
	const auto dot = name.find_last_of(L'.');
	return std::wstring(dot == std::wstring_view::npos ? name : name.substr(0, dot));
}

CatalogEntry EntryFromShellItem(IShellItem* item) {
	CatalogEntry entry;
	entry.source = "appsFolder";
	entry.launch_method = "shellItem";

	CoString parsing;
	if (FAILED(item->GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, parsing.Put()))) {
		return entry;
	}
	entry.parsing_name = parsing.View();

	CoString display;
	if (SUCCEEDED(item->GetDisplayName(SIGDN_NORMALDISPLAY, display.Put()))) {
		entry.display_name = display.View();
	}

	ComPtr<IShellItem2> item2;
	if (SUCCEEDED(item->QueryInterface(
			__uuidof(IShellItem2), reinterpret_cast<void**>(item2.Put())))) {
		CoString aumid;
		if (SUCCEEDED(item2->GetString(PKEY_AppUserModel_ID, aumid.Put()))) {
			entry.aumid = aumid.View();
		}
	}

	// A packaged AUMID is documented as "<PackageFamilyName>!<ApplicationId>", so the family name
	// is read from the identity itself rather than from a second property that older shells may
	// not surface.
	const auto separator = entry.aumid.find(L'!');
	if (separator != std::wstring::npos) {
		entry.package_family = entry.aumid.substr(0, separator);
		entry.kind = "packaged";
	} else {
		entry.kind = "desktop";
	}

	if (entry.display_name.empty()) {
		entry.display_name = entry.aumid.empty() ? entry.parsing_name : entry.aumid;
	}
	entry.id = StableId(entry.source, entry.parsing_name);
	return entry;
}

/// Returns true to stop enumerating.
using AppsFolderVisitor = bool (*)(IShellItem* item, const CatalogEntry& entry, void* state);

HRESULT EnumerateAppsFolder(AppsFolderVisitor visitor, void* state) {
	ComPtr<IShellItem> apps;
	HRESULT result = SHGetKnownFolderItem(
		FOLDERID_AppsFolder,
		KF_FLAG_DEFAULT,
		nullptr,
		__uuidof(IShellItem),
		reinterpret_cast<void**>(apps.Put()));
	if (FAILED(result)) {
		return result;
	}

	ComPtr<IEnumShellItems> items;
	result = apps->BindToHandler(
		nullptr,
		BHID_EnumItems,
		__uuidof(IEnumShellItems),
		reinterpret_cast<void**>(items.Put()));
	if (FAILED(result)) {
		return result;
	}

	for (;;) {
		IShellItem* raw = nullptr;
		ULONG fetched = 0;
		const HRESULT next = items->Next(1, &raw, &fetched);
		if (next == S_FALSE) {
			break;
		}
		if (FAILED(next)) {
			// A partial catalog must be reported as one. Treating a failed step as the end would
			// make "the Shell stopped answering" look like "there are no more apps".
			return next;
		}
		if (fetched != 1 || raw == nullptr) {
			break;
		}

		ComPtr<IShellItem> item;
		item.Attach(raw);
		const CatalogEntry entry = EntryFromShellItem(item.Get());
		if (entry.id.empty()) {
			continue;
		}
		if (visitor(item.Get(), entry, state)) {
			break;
		}
	}
	return S_OK;
}

struct CollectState {
	std::vector<CatalogEntry>* entries;
	std::set<std::wstring>* seen;
	bool* truncated;
	int count;
};

bool CollectAppsFolder(IShellItem*, const CatalogEntry& entry, void* state) {
	auto* collect = static_cast<CollectState*>(state);
	if (collect->entries->size() >= kMaximumEntries) {
		*collect->truncated = true;
		return true;
	}
	if (!collect->seen->insert(CanonicalKey(entry)).second) {
		return false;
	}
	collect->entries->push_back(entry);
	collect->count += 1;
	return false;
}

std::wstring KnownFolder(REFKNOWNFOLDERID id) {
	CoString path;
	if (FAILED(SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, nullptr, path.Put()))) {
		return {};
	}
	return std::wstring(path.View());
}

bool ResolveShortcut(const std::wstring& shortcut, CatalogEntry& entry) {
	ComPtr<IShellLinkW> link;
	if (FAILED(CoCreateInstance(
			CLSID_ShellLink,
			nullptr,
			CLSCTX_INPROC_SERVER,
			__uuidof(IShellLinkW),
			reinterpret_cast<void**>(link.Put())))) {
		return false;
	}

	ComPtr<IPersistFile> persist;
	if (FAILED(link->QueryInterface(
			__uuidof(IPersistFile), reinterpret_cast<void**>(persist.Put())))) {
		return false;
	}
	if (FAILED(persist->Load(shortcut.c_str(), STGM_READ))) {
		return false;
	}

	// SLGP_RAWPATH keeps the shortcut's own text, including environment variables, instead of
	// letting the Shell resolve a moved target to something the user never chose.
	std::vector<wchar_t> target(MAX_PATH * 2, L'\0');
	if (FAILED(link->GetPath(target.data(), static_cast<int>(target.size()), nullptr, SLGP_RAWPATH))) {
		return false;
	}
	const std::wstring resolved = Expand(Unquote(target.data()));
	if (resolved.empty() || !EndsWithExe(resolved)) {
		return false;
	}
	if (GetFileAttributesW(resolved.c_str()) == INVALID_FILE_ATTRIBUTES) {
		return false;
	}

	std::vector<wchar_t> arguments(2048, L'\0');
	if (SUCCEEDED(link->GetArguments(arguments.data(), static_cast<int>(arguments.size())))) {
		entry.arguments = arguments.data();
	}
	std::vector<wchar_t> working(MAX_PATH * 2, L'\0');
	if (SUCCEEDED(link->GetWorkingDirectory(working.data(), static_cast<int>(working.size())))) {
		entry.working_directory = Expand(working.data());
	}

	entry.source = "startMenuShortcuts";
	entry.launch_method = "shortcut";
	entry.kind = "desktop";
	entry.executable_path = resolved;
	entry.shortcut_path = shortcut;
	entry.display_name = FileNameWithoutExtension(shortcut);
	entry.id = StableId(entry.source, Lowercase(shortcut));
	return true;
}

void ScanShortcuts(
	const std::wstring& directory,
	int depth,
	std::vector<CatalogEntry>& entries,
	std::set<std::wstring>& seen,
	int& count,
	bool& truncated) {
	if (directory.empty() || depth > kMaximumShortcutDepth) {
		return;
	}

	WIN32_FIND_DATAW found = {};
	const std::wstring pattern = directory + L"\\*";
	HANDLE search = FindFirstFileW(pattern.c_str(), &found);
	if (search == INVALID_HANDLE_VALUE) {
		return;
	}

	do {
		const std::wstring name = found.cFileName;
		if (name == L"." || name == L"..") {
			continue;
		}
		const std::wstring full = directory + L"\\" + name;
		if ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
			ScanShortcuts(full, depth + 1, entries, seen, count, truncated);
			continue;
		}
		if (name.size() < 5 || Lowercase(name.substr(name.size() - 4)) != L".lnk") {
			continue;
		}
		if (entries.size() >= kMaximumEntries) {
			truncated = true;
			break;
		}

		CatalogEntry entry;
		if (!ResolveShortcut(full, entry)) {
			continue;
		}
		if (!seen.insert(CanonicalKey(entry)).second) {
			continue;
		}
		entries.push_back(entry);
		count += 1;
	} while (FindNextFileW(search, &found));

	FindClose(search);
}

void ScanAppPaths(
	HKEY hive,
	std::wstring_view hive_name,
	std::vector<CatalogEntry>& entries,
	std::set<std::wstring>& seen,
	int& count,
	bool& truncated) {
	HKEY root = nullptr;
	if (RegOpenKeyExW(hive, kAppPathsKey, 0, KEY_READ, &root) != ERROR_SUCCESS) {
		return;
	}

	for (DWORD index = 0;; ++index) {
		wchar_t name[256] = {};
		DWORD length = ARRAYSIZE(name);
		if (RegEnumKeyExW(root, index, name, &length, nullptr, nullptr, nullptr, nullptr)
			!= ERROR_SUCCESS) {
			break;
		}
		if (entries.size() >= kMaximumEntries) {
			truncated = true;
			break;
		}
		if (!EndsWithExe(name)) {
			continue;
		}

		HKEY subkey = nullptr;
		if (RegOpenKeyExW(root, name, 0, KEY_READ, &subkey) != ERROR_SUCCESS) {
			continue;
		}

		wchar_t value[MAX_PATH * 2] = {};
		DWORD bytes = sizeof(value) - sizeof(wchar_t);
		DWORD type = 0;
		const LSTATUS read = RegQueryValueExW(
			subkey, nullptr, nullptr, &type, reinterpret_cast<LPBYTE>(value), &bytes);
		RegCloseKey(subkey);
		if (read != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ)) {
			continue;
		}

		const std::wstring resolved = Expand(Unquote(value));
		if (resolved.empty() || !EndsWithExe(resolved)) {
			continue;
		}
		if (GetFileAttributesW(resolved.c_str()) == INVALID_FILE_ATTRIBUTES) {
			continue;
		}

		CatalogEntry entry;
		entry.source = "appPaths";
		entry.launch_method = "executable";
		entry.kind = "desktop";
		entry.executable_path = resolved;
		entry.display_name = FileNameWithoutExtension(resolved);
		entry.registry_key = std::wstring(hive_name) + L"\\" + kAppPathsKey + L"\\" + name;
		entry.id = StableId(entry.source, Lowercase(entry.registry_key));
		if (!seen.insert(CanonicalKey(entry)).second) {
			continue;
		}
		entries.push_back(entry);
		count += 1;
	}

	RegCloseKey(root);
}

std::string EntryJson(const CatalogEntry& entry) {
	JsonObject object;
	object.String("id", entry.id);
	object.String("displayName", Utf8(entry.display_name));
	object.String("source", entry.source);
	object.String("kind", entry.kind);
	object.String("launchMethod", entry.launch_method);
	object.OptionalString("appUserModelId", entry.aumid);
	object.OptionalString("packageFamilyName", entry.package_family);
	object.OptionalString("executablePath", entry.executable_path);
	object.OptionalString("arguments", entry.arguments);
	object.OptionalString("workingDirectory", entry.working_directory);
	object.OptionalString("parsingName", entry.parsing_name);
	object.OptionalString("shortcutPath", entry.shortcut_path);
	object.OptionalString("registryKey", entry.registry_key);
	return object.Finish();
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

void CaptureProcess(HANDLE process, LaunchOutcome& outcome) {
	if (process == nullptr) {
		return;
	}
	outcome.process_id = GetProcessId(process);
	outcome.process_start_file_time = ProcessStartFileTime(process);
	CloseHandle(process);
}

struct LaunchState {
	const std::string* id;
	LaunchOutcome* outcome;
	bool found;
	HRESULT hresult;
};

bool LaunchAppsFolderMatch(IShellItem* item, const CatalogEntry& entry, void* state) {
	auto* launch = static_cast<LaunchState*>(state);
	if (entry.id != *launch->id) {
		return false;
	}

	launch->found = true;
	launch->outcome->entry = entry;

	PIDLIST_ABSOLUTE pidl = nullptr;
	launch->hresult = SHGetIDListFromObject(item, &pidl);
	if (FAILED(launch->hresult)) {
		return true;
	}

	SHELLEXECUTEINFOW info = {};
	info.cbSize = sizeof(info);
	// INVOKEIDLIST runs the item's own default verb, which is exactly what the Start menu does.
	// No caller-supplied verb, path, or command line reaches this call.
	info.fMask = SEE_MASK_INVOKEIDLIST | SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI
		| SEE_MASK_NOASYNC;
	info.lpIDList = pidl;
	info.nShow = SW_SHOWNORMAL;
	const BOOL started = ShellExecuteExW(&info);
	CoTaskMemFree(pidl);

	if (!started) {
		launch->hresult = HresultFromLastError();
		return true;
	}
	launch->hresult = S_OK;
	CaptureProcess(info.hProcess, *launch->outcome);
	return true;
}

void LaunchFile(
	const std::wstring& file,
	const std::wstring& working_directory,
	LaunchOutcome& outcome) {
	SHELLEXECUTEINFOW info = {};
	info.cbSize = sizeof(info);
	info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
	info.lpFile = file.c_str();
	info.lpDirectory = working_directory.empty() ? nullptr : working_directory.c_str();
	info.nShow = SW_SHOWNORMAL;
	if (!ShellExecuteExW(&info)) {
		throw FatalError(
			"launch_failed",
			"Windows refused to start the catalog entry.",
			HresultFromLastError());
	}
	CaptureProcess(info.hProcess, outcome);
}

} // namespace

Catalog BuildCatalog() {
	Catalog catalog;

	CatalogSourceState apps_folder;
	apps_folder.name = "appsFolder";
	std::set<std::wstring> apps_seen;
	CollectState collect{ &catalog.entries, &apps_seen, &catalog.truncated, 0 };
	apps_folder.hresult = EnumerateAppsFolder(CollectAppsFolder, &collect);
	apps_folder.supported = SUCCEEDED(apps_folder.hresult);
	apps_folder.count = collect.count;
	if (!apps_folder.supported) {
		apps_folder.detail =
			"The Shell would not enumerate FOLDERID_AppsFolder, so packaged apps and Start "
			"entries registered only with the Shell are missing from this catalog.";
	}
	catalog.sources.push_back(apps_folder);

	CatalogSourceState shortcuts;
	shortcuts.name = "startMenuShortcuts";
	shortcuts.supported = true;
	std::set<std::wstring> shortcut_seen;
	int shortcut_count = 0;
	ScanShortcuts(
		KnownFolder(FOLDERID_Programs),
		0,
		catalog.entries,
		shortcut_seen,
		shortcut_count,
		catalog.truncated);
	ScanShortcuts(
		KnownFolder(FOLDERID_CommonPrograms),
		0,
		catalog.entries,
		shortcut_seen,
		shortcut_count,
		catalog.truncated);
	shortcuts.count = shortcut_count;
	catalog.sources.push_back(shortcuts);

	CatalogSourceState app_paths;
	app_paths.name = "appPaths";
	app_paths.supported = true;
	std::set<std::wstring> app_path_seen;
	int app_path_count = 0;
	ScanAppPaths(
		HKEY_CURRENT_USER,
		L"HKCU",
		catalog.entries,
		app_path_seen,
		app_path_count,
		catalog.truncated);
	ScanAppPaths(
		HKEY_LOCAL_MACHINE,
		L"HKLM",
		catalog.entries,
		app_path_seen,
		app_path_count,
		catalog.truncated);
	app_paths.count = app_path_count;
	catalog.sources.push_back(app_paths);

	return catalog;
}

std::string CatalogJson(const Catalog& catalog) {
	JsonArray sources;
	for (const auto& source : catalog.sources) {
		JsonObject object;
		object.String("name", source.name);
		object.Boolean("supported", source.supported);
		object.Number("count", static_cast<std::uint64_t>(source.count));
		object.String("hresult", HresultHex(source.hresult));
		if (!source.detail.empty()) {
			object.String("detail", source.detail);
		}
		sources.Raw(object.Finish());
	}

	JsonArray entries;
	for (const auto& entry : catalog.entries) {
		entries.Raw(EntryJson(entry));
	}

	JsonObject root;
	root.Number("schemaVersion", 1);
	root.Boolean("ok", true);
	root.String("helperVersion", Utf8(MOBILE_CANVAS_HELPER_VERSION));
	root.Boolean("truncated", catalog.truncated);
	root.Raw("sources", sources.Finish());
	root.Raw("entries", entries.Finish());
	return root.Finish();
}

LaunchOutcome LaunchCatalogEntry(const std::string& entry_id) {
	LaunchOutcome outcome;

	LaunchState state{ &entry_id, &outcome, false, S_OK };
	const HRESULT enumeration = EnumerateAppsFolder(LaunchAppsFolderMatch, &state);
	if (state.found) {
		if (FAILED(state.hresult)) {
			throw FatalError(
				"launch_failed",
				"Windows refused to start the catalog entry.",
				state.hresult);
		}
		return outcome;
	}
	// A failed AppsFolder enumeration is not fatal on its own: the entry may still come from a
	// shortcut or App Paths, and refusing to look would report the wrong reason.
	(void)enumeration;

	const Catalog catalog = BuildCatalog();
	for (const auto& entry : catalog.entries) {
		if (entry.id != entry_id) {
			continue;
		}
		outcome.entry = entry;
		if (!entry.shortcut_path.empty()) {
			LaunchFile(entry.shortcut_path, entry.working_directory, outcome);
			return outcome;
		}
		if (!entry.executable_path.empty()) {
			LaunchFile(entry.executable_path, entry.working_directory, outcome);
			return outcome;
		}
		throw FatalError(
			"launch_unsupported",
			"That catalog entry has no launch provenance this helper can act on.");
	}

	throw FatalError("entry_not_found", "No catalog entry matches that identifier.");
}

std::string LaunchJson(const LaunchOutcome& outcome) {
	JsonObject root;
	root.Number("schemaVersion", 1);
	root.Boolean("ok", true);
	root.String("helperVersion", Utf8(MOBILE_CANVAS_HELPER_VERSION));
	root.Raw("entry", EntryJson(outcome.entry));
	root.Number("processId", outcome.process_id);
	root.Number("processStartFileTime", outcome.process_start_file_time);
	root.String("launchMethod", outcome.entry.launch_method);
	return root.Finish();
}

} // namespace helper
