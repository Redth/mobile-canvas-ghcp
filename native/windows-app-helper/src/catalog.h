#pragma once

#include "support.h"

#include <string>
#include <vector>

namespace helper {

/// One launchable app as one source reported it. The host merges rows across sources into the
/// catalog it shows; this level stays faithful to where each row came from.
struct CatalogEntry {
	std::string id;
	std::wstring display_name;
	std::string source;
	std::string kind;
	std::string launch_method;
	std::wstring aumid;
	std::wstring package_family;
	std::wstring executable_path;
	std::wstring arguments;
	std::wstring working_directory;
	std::wstring parsing_name;
	std::wstring shortcut_path;
	std::wstring registry_key;
};

struct CatalogSourceState {
	std::string name;
	bool supported = false;
	int count = 0;
	HRESULT hresult = S_OK;
	std::string detail;
};

struct Catalog {
	std::vector<CatalogEntry> entries;
	std::vector<CatalogSourceState> sources;
	bool truncated = false;
};

struct LaunchOutcome {
	CatalogEntry entry;
	std::uint32_t process_id = 0;
	std::uint64_t process_start_file_time = 0;
};

Catalog BuildCatalog();
std::string CatalogJson(const Catalog& catalog);
LaunchOutcome LaunchCatalogEntry(const std::string& entry_id);
std::string LaunchJson(const LaunchOutcome& outcome);

} // namespace helper
