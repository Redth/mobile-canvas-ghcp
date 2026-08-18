#include "support.h"

#include <bcrypt.h>

#include <array>

namespace helper {
namespace {

constexpr std::uint32_t kIntegrityLow = SECURITY_MANDATORY_LOW_RID;
constexpr std::uint32_t kIntegrityMedium = SECURITY_MANDATORY_MEDIUM_RID;
constexpr std::uint32_t kIntegrityHigh = SECURITY_MANDATORY_HIGH_RID;
constexpr std::uint32_t kIntegritySystem = SECURITY_MANDATORY_SYSTEM_RID;

std::string IntegrityName(std::uint32_t rid) {
	if (rid >= kIntegritySystem) {
		return "system";
	}
	if (rid >= kIntegrityHigh) {
		return "high";
	}
	if (rid >= kIntegrityMedium) {
		return "medium";
	}
	if (rid >= kIntegrityLow) {
		return "low";
	}
	return "untrusted";
}

} // namespace

std::string StableId(std::string_view scope, std::wstring_view identity) {
	std::string material(scope);
	material += '|';
	material += Utf8(identity);

	BCRYPT_ALG_HANDLE algorithm = nullptr;
	NTSTATUS status = BCryptOpenAlgorithmProvider(
		&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
	if (status < 0) {
		throw FatalError("hash_unavailable", "Could not open the SHA-256 provider.");
	}

	std::array<UCHAR, 32> digest = {};
	status = BCryptHash(
		algorithm,
		nullptr,
		0,
		reinterpret_cast<PUCHAR>(material.data()),
		static_cast<ULONG>(material.size()),
		digest.data(),
		static_cast<ULONG>(digest.size()));
	BCryptCloseAlgorithmProvider(algorithm, 0);
	if (status < 0) {
		throw FatalError("hash_failed", "Could not hash a catalog identity.");
	}

	static constexpr char hex[] = "0123456789abcdef";
	std::string id;
	id.reserve(32);
	// Half of SHA-256 is far past the point where a few thousand installed apps could collide,
	// and it keeps the identifier short enough to pass around a command line.
	for (size_t index = 0; index < 16; ++index) {
		id += hex[digest[index] >> 4];
		id += hex[digest[index] & 0x0f];
	}
	return id;
}

IntegrityInfo QueryIntegrity(HANDLE process) {
	IntegrityInfo info;
	if (process == nullptr) {
		info.level = "unknown";
		return info;
	}

	HANDLE token = nullptr;
	if (!OpenProcessToken(process, TOKEN_QUERY, &token)) {
		info.level = "unknown";
		return info;
	}

	DWORD needed = 0;
	GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &needed);
	std::vector<unsigned char> buffer(needed == 0 ? sizeof(TOKEN_MANDATORY_LABEL) : needed);
	if (GetTokenInformation(
			token,
			TokenIntegrityLevel,
			buffer.data(),
			static_cast<DWORD>(buffer.size()),
			&needed)) {
		auto* label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(buffer.data());
		const DWORD count = *GetSidSubAuthorityCount(label->Label.Sid);
		if (count > 0) {
			info.value = *GetSidSubAuthority(label->Label.Sid, count - 1);
			info.level = IntegrityName(info.value);
			info.known = true;
		}
	}

	TOKEN_ELEVATION elevation = {};
	DWORD elevation_size = sizeof(elevation);
	if (GetTokenInformation(
			token, TokenElevation, &elevation, elevation_size, &elevation_size)) {
		info.elevated = elevation.TokenIsElevated != 0;
	}

	CloseHandle(token);
	if (!info.known) {
		info.level = "unknown";
	}
	return info;
}

IntegrityInfo CurrentProcessIntegrity() {
	return QueryIntegrity(GetCurrentProcess());
}

SessionInfo CurrentSession() {
	SessionInfo session;
	DWORD id = 0;
	if (ProcessIdToSessionId(GetCurrentProcessId(), &id)) {
		session.id = id;
		session.interactive = id != 0;
	}
	session.integrity = CurrentProcessIntegrity();
	return session;
}

std::string SessionJson(const SessionInfo& session) {
	JsonObject object;
	object.Number("id", session.id);
	object.Boolean("interactive", session.interactive);
	object.String("integrityLevel", session.integrity.level);
	object.Number("integrityValue", session.integrity.value);
	return object.Finish();
}

std::uint32_t WindowProcessId(HWND window) {
	DWORD process_id = 0;
	if (window == nullptr || GetWindowThreadProcessId(window, &process_id) == 0) {
		return 0;
	}
	return process_id;
}

std::uint64_t WindowProcessStartFileTime(HWND window) {
	const DWORD process_id = WindowProcessId(window);
	if (process_id == 0) {
		return 0;
	}
	HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
	if (process == nullptr) {
		return 0;
	}

	FILETIME creation = {};
	FILETIME exited = {};
	FILETIME kernel = {};
	FILETIME user = {};
	const BOOL ok = GetProcessTimes(process, &creation, &exited, &kernel, &user);
	CloseHandle(process);
	if (ok == FALSE) {
		return 0;
	}
	return (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32)
		| static_cast<std::uint64_t>(creation.dwLowDateTime);
}

} // namespace helper
