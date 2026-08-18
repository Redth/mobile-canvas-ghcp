#pragma once

#include <windows.h>
#include <objbase.h>
#include <roapi.h>

#include <cstdint>
#include <cstdio>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace helper {

/// A failure that already carries the machine-readable code the host branches on.
class FatalError final : public std::runtime_error {
public:
	FatalError(std::string code, std::string message)
		: std::runtime_error(message), code_(std::move(code)) {}

	FatalError(std::string code, std::string message, HRESULT hresult)
		: std::runtime_error(message), code_(std::move(code)), hresult_(hresult), has_hresult_(true) {}

	const std::string& Code() const noexcept {
		return code_;
	}

	bool HasHresult() const noexcept {
		return has_hresult_;
	}

	HRESULT Hresult() const noexcept {
		return hresult_;
	}

private:
	std::string code_;
	HRESULT hresult_ = S_OK;
	bool has_hresult_ = false;
};

inline HRESULT HresultFromLastError() {
	const DWORD error = GetLastError();
	return error == ERROR_SUCCESS ? E_FAIL : HRESULT_FROM_WIN32(error);
}

inline std::string HresultHex(HRESULT hresult) {
	char text[11] = {};
	std::snprintf(
		text,
		sizeof(text),
		"0x%08lX",
		static_cast<unsigned long>(static_cast<std::uint32_t>(hresult)));
	return text;
}

/// UTF-16 to UTF-8. Window titles and shell display names come from other programs, so an
/// unpaired surrogate is replaced rather than allowed to fail a whole enumeration.
inline std::string Utf8(std::wstring_view value) {
	if (value.empty()) {
		return {};
	}
	if (value.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
		throw FatalError("unicode_conversion_failed", "A Windows string was too long to encode as UTF-8.");
	}

	const int wide_length = static_cast<int>(value.size());
	const int byte_length = WideCharToMultiByte(
		CP_UTF8, 0, value.data(), wide_length, nullptr, 0, nullptr, nullptr);
	if (byte_length == 0) {
		throw FatalError(
			"unicode_conversion_failed",
			"Could not encode a Windows string as UTF-8.",
			HresultFromLastError());
	}

	std::string result(static_cast<size_t>(byte_length), '\0');
	if (WideCharToMultiByte(
			CP_UTF8, 0, value.data(), wide_length, result.data(), byte_length, nullptr, nullptr)
		== 0) {
		throw FatalError(
			"unicode_conversion_failed",
			"Could not encode a Windows string as UTF-8.",
			HresultFromLastError());
	}
	return result;
}

inline std::string JsonEscape(std::string_view value) {
	static constexpr char hex[] = "0123456789abcdef";
	std::string result;
	result.reserve(value.size() + 8);

	for (const unsigned char character : value) {
		switch (character) {
		case '"':
			result += "\\\"";
			break;
		case '\\':
			result += "\\\\";
			break;
		case '\b':
			result += "\\b";
			break;
		case '\f':
			result += "\\f";
			break;
		case '\n':
			result += "\\n";
			break;
		case '\r':
			result += "\\r";
			break;
		case '\t':
			result += "\\t";
			break;
		default:
			if (character < 0x20) {
				result += "\\u00";
				result += hex[character >> 4];
				result += hex[character & 0x0f];
			} else {
				result += static_cast<char>(character);
			}
			break;
		}
	}
	return result;
}

class JsonObject final {
public:
	void String(std::string_view key, std::string_view value) {
		Key(key);
		body_ += '"';
		body_ += JsonEscape(value);
		body_ += '"';
	}

	/// Writes a string, or JSON null when the value is empty. Absent is not the same as blank:
	/// the host distinguishes "this app has no AUMID" from "its AUMID is an empty string".
	void OptionalString(std::string_view key, std::wstring_view value) {
		if (value.empty()) {
			Key(key);
			body_ += "null";
			return;
		}
		String(key, Utf8(value));
	}

	void Boolean(std::string_view key, bool value) {
		Key(key);
		body_ += value ? "true" : "false";
	}

	void Number(std::string_view key, std::uint64_t value) {
		Key(key);
		body_ += std::to_string(value);
	}

	void Signed(std::string_view key, std::int64_t value) {
		Key(key);
		body_ += std::to_string(value);
	}

	/// Writes a finite double with enough precision to round-trip a capture scale. A non-finite
	/// value would produce invalid JSON, so it is written as 0 rather than as NaN.
	void Double(std::string_view key, double value) {
		Key(key);
		if (!(value == value) || value > 1e308 || value < -1e308) {
			body_ += '0';
			return;
		}
		char text[64] = {};
		const int written = std::snprintf(text, sizeof(text), "%.6g", value);
		body_ += (written > 0) ? std::string(text, static_cast<size_t>(written)) : "0";
	}

	void Raw(std::string_view key, std::string_view value) {
		Key(key);
		body_ += value;
	}

	std::string Finish() const {
		return body_ + '}';
	}

private:
	void Key(std::string_view key) {
		if (!first_) {
			body_ += ',';
		}
		first_ = false;
		body_ += '"';
		body_ += JsonEscape(key);
		body_ += "\":";
	}

	std::string body_ = "{";
	bool first_ = true;
};

class JsonArray final {
public:
	void Raw(std::string_view value) {
		Separate();
		body_ += value;
	}

	void String(std::string_view value) {
		Separate();
		body_ += '"';
		body_ += JsonEscape(value);
		body_ += '"';
	}

	std::string Finish() const {
		return body_ + ']';
	}

private:
	void Separate() {
		if (!first_) {
			body_ += ',';
		}
		first_ = false;
	}

	std::string body_ = "[";
	bool first_ = true;
};

inline std::string ErrorJson(
	std::string_view code,
	std::string_view message,
	HRESULT hresult = S_OK,
	bool include_hresult = false) {
	JsonObject error;
	error.String("code", code);
	error.String("message", message);
	if (include_hresult) {
		error.String("hresult", HresultHex(hresult));
	}

	JsonObject root;
	root.Number("schemaVersion", 1);
	root.Boolean("ok", false);
	root.Raw("error", error.Finish());
	return root.Finish();
}

template <typename T>
class ComPtr final {
public:
	ComPtr() = default;

	~ComPtr() {
		Reset();
	}

	ComPtr(const ComPtr&) = delete;
	ComPtr& operator=(const ComPtr&) = delete;

	ComPtr(ComPtr&& other) noexcept : value_(other.value_) {
		other.value_ = nullptr;
	}

	ComPtr& operator=(ComPtr&& other) noexcept {
		if (this != &other) {
			Reset();
			value_ = other.value_;
			other.value_ = nullptr;
		}
		return *this;
	}

	T** Put() noexcept {
		Reset();
		return &value_;
	}

	void Attach(T* value) noexcept {
		Reset();
		value_ = value;
	}

	T* Get() const noexcept {
		return value_;
	}

	T* operator->() const noexcept {
		return value_;
	}

	explicit operator bool() const noexcept {
		return value_ != nullptr;
	}

	void Reset() noexcept {
		if (value_ != nullptr) {
			value_->Release();
			value_ = nullptr;
		}
	}

private:
	T* value_ = nullptr;
};

/// A string the Shell allocated with CoTaskMemAlloc.
class CoString final {
public:
	CoString() = default;

	~CoString() {
		Reset();
	}

	CoString(const CoString&) = delete;
	CoString& operator=(const CoString&) = delete;

	PWSTR* Put() noexcept {
		Reset();
		return &value_;
	}

	std::wstring_view View() const noexcept {
		return value_ == nullptr ? std::wstring_view() : std::wstring_view(value_);
	}

	void Reset() noexcept {
		if (value_ != nullptr) {
			CoTaskMemFree(value_);
			value_ = nullptr;
		}
	}

private:
	PWSTR value_ = nullptr;
};

class Apartment final {
public:
	Apartment() {
		const HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
		if (FAILED(com_result)) {
			throw FatalError(
				"com_initialization_failed",
				"Could not initialize the COM multithreaded apartment.",
				com_result);
		}
		com_initialized_ = true;

		const HRESULT winrt_result = RoInitialize(RO_INIT_MULTITHREADED);
		if (FAILED(winrt_result)) {
			CoUninitialize();
			com_initialized_ = false;
			throw FatalError(
				"winrt_initialization_failed",
				"Could not initialize the Windows Runtime multithreaded apartment.",
				winrt_result);
		}
		winrt_initialized_ = true;
	}

	~Apartment() {
		if (winrt_initialized_) {
			RoUninitialize();
		}
		if (com_initialized_) {
			CoUninitialize();
		}
	}

	Apartment(const Apartment&) = delete;
	Apartment& operator=(const Apartment&) = delete;

private:
	bool com_initialized_ = false;
	bool winrt_initialized_ = false;
};

/// A stable, opaque identifier derived from launch provenance rather than from a display name.
/// The same app keeps the same identifier across runs, and two apps that merely share a friendly
/// name never collide.
std::string StableId(std::string_view scope, std::wstring_view identity);

/// Windows integrity level of a process token, as the name and RID the host compares.
struct IntegrityInfo {
	std::string level;
	std::uint32_t value = 0;
	bool elevated = false;
	bool known = false;
};

IntegrityInfo QueryIntegrity(HANDLE process);
IntegrityInfo CurrentProcessIntegrity();

/// The Windows logon session this helper runs in. Session 0 is the service session, which has no
/// desktop, so anything running there is reported as non-interactive rather than as broken.
struct SessionInfo {
	std::uint32_t id = 0;
	bool interactive = false;
	IntegrityInfo integrity;
};

SessionInfo CurrentSession();
std::string SessionJson(const SessionInfo& session);

/// The process behind a window, and when that process started. The pair is what makes a window's
/// identity unique: Windows reuses process IDs, so a creation time is what stops a recycled one
/// from inheriting somebody's grant. Both are echoed back on captures so the host can prove the
/// bytes came from the window it authorized.
std::uint32_t WindowProcessId(HWND window);
std::uint64_t WindowProcessStartFileTime(HWND window);

} // namespace helper
