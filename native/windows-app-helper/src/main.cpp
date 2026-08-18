#include <windows.h>
#include <roapi.h>
#include <winstring.h>

#include <ShlObj_core.h>
#include <ShObjIdl_core.h>
#include <KnownFolders.h>
#include <UIAutomation.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <softpub.h>
#include <windows.graphics.capture.interop.h>
#include <wintrust.h>

#include <cstdint>
#include <cstdio>
#include <exception>
#include <initializer_list>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "catalog.h"
#include "capture.h"
#include "support.h"
#include "uia.h"
#include "version.h"
#include "windows_enum.h"

namespace {

using helper::Apartment;
using helper::ComPtr;
using helper::FatalError;
using helper::HresultFromLastError;
using helper::HresultHex;
using helper::JsonObject;
using helper::Utf8;

constexpr DWORD kWindowsGraphicsCaptureMinimumBuild = 18362;
constexpr size_t kMaximumUiaRequestBytes = 64 * 1024;

/// Options that carry a value. Everything else is a flag, so a stray word can never be swallowed
/// as the argument of an option that does not take one.
bool TakesValue(std::wstring_view option) {
	return option == L"--id";
}

bool IsHexIdentifier(std::wstring_view value) {
	if (value.empty() || value.size() > 128) {
		return false;
	}
	for (const wchar_t character : value) {
		const bool digit = character >= L'0' && character <= L'9';
		const bool lower = character >= L'a' && character <= L'f';
		if (!digit && !lower) {
			return false;
		}
	}
	return true;
}

struct ParsedArguments {
	std::wstring command;
	std::map<std::wstring, std::wstring> options;

	bool Has(std::wstring_view name) const {
		return options.find(std::wstring(name)) != options.end();
	}

	const std::wstring& Value(std::wstring_view name) const {
		return options.at(std::wstring(name));
	}
};

ParsedArguments ParseArguments(int argc, wchar_t* argv[]) {
	if (argc < 2) {
		throw FatalError("invalid_arguments", "A command is required.");
	}

	ParsedArguments parsed;
	parsed.command = argv[1];
	for (int index = 2; index < argc; ++index) {
		const std::wstring option = argv[index];
		if (option.size() <= 2 || option.rfind(L"--", 0) != 0) {
			throw FatalError("invalid_arguments", "Options must use the --name form.");
		}

		std::wstring value;
		if (TakesValue(option)) {
			if (index + 1 >= argc) {
				throw FatalError("invalid_arguments", "An option is missing its value.");
			}
			value = argv[++index];
			if (value.rfind(L"--", 0) == 0) {
				throw FatalError("invalid_arguments", "An option is missing its value.");
			}
		}

		if (!parsed.options.emplace(option, value).second) {
			throw FatalError("invalid_arguments", "Duplicate options are not allowed.");
		}
	}
	return parsed;
}

void RequireExactOptions(
	const ParsedArguments& arguments,
	std::initializer_list<std::wstring_view> expected,
	std::string_view usage) {
	if (arguments.options.size() != expected.size()) {
		throw FatalError("invalid_arguments", std::string(usage));
	}
	for (const auto& option : expected) {
		if (!arguments.Has(option)) {
			throw FatalError("invalid_arguments", std::string(usage));
		}
	}
}

struct OperatingSystemInfo {
	DWORD major = 0;
	DWORD minor = 0;
	DWORD build = 0;
	std::wstring architecture;
};

std::wstring NativeArchitecture() {
	SYSTEM_INFO system_info = {};
	GetNativeSystemInfo(&system_info);

	switch (system_info.wProcessorArchitecture) {
	case PROCESSOR_ARCHITECTURE_AMD64:
		return L"x64";
	case PROCESSOR_ARCHITECTURE_INTEL:
		return L"x86";
#ifdef PROCESSOR_ARCHITECTURE_ARM64
	case PROCESSOR_ARCHITECTURE_ARM64:
		return L"arm64";
#endif
	case PROCESSOR_ARCHITECTURE_ARM:
		return L"arm";
	default:
		return L"unknown";
	}
}

OperatingSystemInfo GetOperatingSystemInfo() {
	OSVERSIONINFOEXW version = {};
	version.dwOSVersionInfoSize = sizeof(version);

#pragma warning(push)
#pragma warning(disable : 4996)
	const BOOL version_ok = GetVersionExW(reinterpret_cast<OSVERSIONINFOW*>(&version));
#pragma warning(pop)

	if (!version_ok) {
		throw FatalError(
			"os_version_query_failed",
			"Could not query the Windows version.",
			HresultFromLastError());
	}

	return {
		version.dwMajorVersion,
		version.dwMinorVersion,
		version.dwBuildNumber,
		NativeArchitecture(),
	};
}

std::wstring BinaryArchitecture() {
#if defined(_M_X64)
	return L"x64";
#elif defined(_M_ARM64)
	return L"arm64";
#elif defined(_M_IX86)
	return L"x86";
#elif defined(_M_ARM)
	return L"arm";
#else
	return L"unknown";
#endif
}

struct FeatureResult {
	bool available;
	HRESULT hresult;
};

FeatureResult ProbeShellAppCatalog() {
	ComPtr<IShellItem> apps_folder;
	const HRESULT result = SHGetKnownFolderItem(
		FOLDERID_AppsFolder,
		KF_FLAG_DEFAULT,
		nullptr,
		__uuidof(IShellItem),
		reinterpret_cast<void**>(apps_folder.Put()));
	return { SUCCEEDED(result), result };
}

FeatureResult ProbeUiAutomation() {
	ComPtr<IUIAutomation> automation;
	const HRESULT result = CoCreateInstance(
		CLSID_CUIAutomation,
		nullptr,
		CLSCTX_INPROC_SERVER,
		__uuidof(IUIAutomation),
		reinterpret_cast<void**>(automation.Put()));
	return { SUCCEEDED(result), result };
}

FeatureResult ProbeWindowsGraphicsCapture(const OperatingSystemInfo& os) {
	if (os.major < 10 || (os.major == 10 && os.build < kWindowsGraphicsCaptureMinimumBuild)) {
		return { false, HRESULT_FROM_WIN32(ERROR_OLD_WIN_VERSION) };
	}

	constexpr wchar_t capture_item_class[] =
		L"Windows.Graphics.Capture.GraphicsCaptureItem";
	HSTRING class_name = nullptr;
	HRESULT result = WindowsCreateString(
		capture_item_class,
		static_cast<UINT32>((sizeof(capture_item_class) / sizeof(wchar_t)) - 1),
		&class_name);
	if (FAILED(result)) {
		return { false, result };
	}

	ComPtr<IGraphicsCaptureItemInterop> capture_item_interop;
	result = RoGetActivationFactory(
		class_name,
		__uuidof(IGraphicsCaptureItemInterop),
		reinterpret_cast<void**>(capture_item_interop.Put()));
	WindowsDeleteString(class_name);
	return { SUCCEEDED(result), result };
}

FeatureResult ProbeMediaFoundationH264() {
	const HRESULT startup_result = MFStartup(MF_VERSION, MFSTARTUP_LITE);
	if (FAILED(startup_result)) {
		return { false, startup_result };
	}

	MFT_REGISTER_TYPE_INFO output_type = {
		MFMediaType_Video,
		MFVideoFormat_H264,
	};
	IMFActivate** activations = nullptr;
	UINT32 activation_count = 0;
	const HRESULT enumeration_result = MFTEnumEx(
		MFT_CATEGORY_VIDEO_ENCODER,
		static_cast<UINT32>(
			MFT_ENUM_FLAG_SYNCMFT
			| MFT_ENUM_FLAG_ASYNCMFT
			| MFT_ENUM_FLAG_HARDWARE
			| MFT_ENUM_FLAG_LOCALMFT),
		nullptr,
		&output_type,
		&activations,
		&activation_count);

	for (UINT32 index = 0; index < activation_count; ++index) {
		activations[index]->Release();
	}
	CoTaskMemFree(activations);
	MFShutdown();

	if (FAILED(enumeration_result)) {
		return { false, enumeration_result };
	}
	if (activation_count == 0) {
		return { false, HRESULT_FROM_WIN32(ERROR_NOT_FOUND) };
	}
	return { true, S_OK };
}

FeatureResult ProbeSendInput() {
	HMODULE user32 = GetModuleHandleW(L"user32.dll");
	bool loaded_here = false;
	if (user32 == nullptr) {
		user32 = LoadLibraryW(L"user32.dll");
		loaded_here = user32 != nullptr;
	}
	if (user32 == nullptr) {
		return { false, HresultFromLastError() };
	}

	const FARPROC send_input = GetProcAddress(user32, "SendInput");
	if (loaded_here) {
		FreeLibrary(user32);
	}
	if (send_input == nullptr) {
		return { false, HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND) };
	}
	return { true, S_OK };
}

std::wstring ExecutablePath() {
	std::vector<wchar_t> buffer(MAX_PATH);
	for (;;) {
		const DWORD length = GetModuleFileNameW(
			nullptr,
			buffer.data(),
			static_cast<DWORD>(buffer.size()));
		if (length == 0) {
			throw FatalError(
				"executable_path_failed",
				"Could not locate the helper executable.",
				HresultFromLastError());
		}
		if (length < buffer.size() - 1) {
			return std::wstring(buffer.data(), length);
		}
		if (buffer.size() >= 32768) {
			throw FatalError("executable_path_failed", "The helper executable path is too long.");
		}
		buffer.resize(buffer.size() * 2);
	}
}

struct SignatureResult {
	bool valid;
	std::string status;
	HRESULT hresult;
};

SignatureResult ProbeAuthenticodeSignature() {
	const std::wstring executable = ExecutablePath();
	WINTRUST_FILE_INFO file_info = {};
	file_info.cbStruct = sizeof(file_info);
	file_info.pcwszFilePath = executable.c_str();

	WINTRUST_DATA trust_data = {};
	trust_data.cbStruct = sizeof(trust_data);
	trust_data.dwUIChoice = WTD_UI_NONE;
	trust_data.fdwRevocationChecks = WTD_REVOKE_NONE;
	trust_data.dwUnionChoice = WTD_CHOICE_FILE;
	trust_data.pFile = &file_info;
	trust_data.dwStateAction = WTD_STATEACTION_VERIFY;

	// The action identifier is a braced initializer macro, so it has to become an object before
	// its address can be taken.
	GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
	LONG trust_result = WinVerifyTrust(nullptr, &action, &trust_data);

	trust_data.dwStateAction = WTD_STATEACTION_CLOSE;
	WinVerifyTrust(nullptr, &action, &trust_data);

	if (trust_result == ERROR_SUCCESS) {
		return { true, "valid", S_OK };
	}
	if (trust_result == TRUST_E_NOSIGNATURE) {
		return { false, "unsigned", static_cast<HRESULT>(trust_result) };
	}
	return { false, "invalid", static_cast<HRESULT>(trust_result) };
}

std::string FeatureJson(const FeatureResult& feature) {
	JsonObject object;
	object.Boolean("available", feature.available);
	object.String("hresult", HresultHex(feature.hresult));
	return object.Finish();
}

std::string WindowsGraphicsCaptureJson(
	const FeatureResult& feature,
	const OperatingSystemInfo& os) {
	JsonObject object;
	object.Boolean("available", feature.available);
	object.Number("minimumBuild", kWindowsGraphicsCaptureMinimumBuild);
	object.Number("reportedBuild", os.build);
	object.String("hresult", HresultHex(feature.hresult));
	return object.Finish();
}

std::string AuthenticodeJson(const SignatureResult& signature) {
	JsonObject object;
	object.Boolean("valid", signature.valid);
	object.String("status", signature.status);
	object.String("hresult", HresultHex(signature.hresult));
	return object.Finish();
}

std::string CapabilitiesJson() {
	Apartment apartment;
	const OperatingSystemInfo os = GetOperatingSystemInfo();
	const FeatureResult shell_catalog = ProbeShellAppCatalog();
	const FeatureResult ui_automation = ProbeUiAutomation();
	const FeatureResult graphics_capture = ProbeWindowsGraphicsCapture(os);
	const FeatureResult media_foundation_h264 = ProbeMediaFoundationH264();
	const FeatureResult send_input = ProbeSendInput();
	const SignatureResult authenticode = ProbeAuthenticodeSignature();

	JsonObject os_json;
	os_json.String("family", "Windows");
	os_json.Number("major", os.major);
	os_json.Number("minor", os.minor);
	os_json.Number("build", os.build);
	os_json.String("nativeArchitecture", Utf8(os.architecture));

	JsonObject features_json;
	features_json.Raw("shellAppCatalog", FeatureJson(shell_catalog));
	features_json.Raw("uiAutomation", FeatureJson(ui_automation));
	features_json.Raw(
		"windowsGraphicsCapture",
		WindowsGraphicsCaptureJson(graphics_capture, os));
	features_json.Raw("mediaFoundationH264", FeatureJson(media_foundation_h264));
	features_json.Raw("sendInput", FeatureJson(send_input));
	features_json.Raw("authenticodeSignature", AuthenticodeJson(authenticode));

	JsonObject result;
	result.Number("schemaVersion", 1);
	result.Boolean("ok", true);
	result.String("helperVersion", Utf8(MOBILE_CANVAS_HELPER_VERSION));
	result.String("architecture", Utf8(BinaryArchitecture()));
	result.Raw("os", os_json.Finish());
	// Which desktop this helper can see at all. A service session has none, and that has to be a
	// reported state rather than an empty window list that reads like a quiet desktop.
	result.Raw("session", helper::SessionJson(helper::CurrentSession()));
	result.Raw("features", features_json.Finish());
	return result.Finish();
}

std::string CatalogCommandJson() {
	Apartment apartment;
	return helper::CatalogJson(helper::BuildCatalog());
}

std::string WindowsCommandJson() {
	Apartment apartment;
	return helper::WindowListJson(helper::EnumerateWindows());
}

std::string LaunchCommandJson(const std::wstring& entry_id) {
	if (!IsHexIdentifier(entry_id)) {
		throw FatalError(
			"invalid_arguments",
			"--id must be a lowercase hexadecimal catalog entry identifier.");
	}
	Apartment apartment;
	return helper::LaunchJson(helper::LaunchCatalogEntry(Utf8(entry_id)));
}

std::string ReadRequest(const char* code, const char* missing) {
	std::string request;
	char buffer[4096] = {};
	for (;;) {
		std::cin.read(buffer, static_cast<std::streamsize>(sizeof(buffer)));
		const std::streamsize read = std::cin.gcount();
		if (read > 0) {
			if (request.size() + static_cast<size_t>(read) > kMaximumUiaRequestBytes) {
				throw FatalError(code, "The request is too large.");
			}
			request.append(buffer, static_cast<size_t>(read));
		}
		if (std::cin.eof()) {
			break;
		}
		if (std::cin.fail()) {
			throw FatalError(code, "Could not read the request.");
		}
	}
	if (request.empty()) {
		throw FatalError(code, missing);
	}
	return request;
}

std::string ReadUiaRequest() {
	return ReadRequest(
		"uia_invalid_request",
		"A versioned UI Automation JSON request is required on standard input.");
}

int Run(const ParsedArguments& arguments) {
	if (arguments.command == L"capabilities") {
		RequireExactOptions(
			arguments, { L"--json" }, "capabilities requires exactly one --json option.");
		std::cout << CapabilitiesJson() << '\n';
		return 0;
	}
	if (arguments.command == L"catalog") {
		RequireExactOptions(
			arguments, { L"--json" }, "catalog requires exactly one --json option.");
		std::cout << CatalogCommandJson() << '\n';
		return 0;
	}
	if (arguments.command == L"windows") {
		RequireExactOptions(
			arguments, { L"--json" }, "windows requires exactly one --json option.");
		std::cout << WindowsCommandJson() << '\n';
		return 0;
	}
	if (arguments.command == L"launch") {
		RequireExactOptions(
			arguments,
			{ L"--json", L"--id" },
			"launch requires exactly --json and --id <entry-id>.");
		std::cout << LaunchCommandJson(arguments.Value(L"--id")) << '\n';
		return 0;
	}
	if (arguments.command == L"uia-snapshot") {
		RequireExactOptions(
			arguments,
			{ L"--json" },
			"uia-snapshot requires exactly one --json option and a JSON request on standard input.");
		std::cout << helper::UiaSnapshotJson(ReadUiaRequest()) << '\n';
		return 0;
	}
	if (arguments.command == L"uia-find") {
		RequireExactOptions(
			arguments,
			{ L"--json" },
			"uia-find requires exactly one --json option and a JSON request on standard input.");
		std::cout << helper::UiaFindJson(ReadUiaRequest()) << '\n';
		return 0;
	}
	if (arguments.command == L"uia-action") {
		RequireExactOptions(
			arguments,
			{ L"--json" },
			"uia-action requires exactly one --json option and a JSON request on standard input.");
		std::cout << helper::UiaActionJson(ReadUiaRequest()) << '\n';
		return 0;
	}
	if (arguments.command == L"uia-wait") {
		RequireExactOptions(
			arguments,
			{ L"--json" },
			"uia-wait requires exactly one --json option and a JSON request on standard input.");
		std::cout << helper::UiaWaitJson(ReadUiaRequest()) << '\n';
		return 0;
	}
	if (arguments.command == L"screenshot") {
		RequireExactOptions(
			arguments,
			{ L"--json" },
			"screenshot requires exactly one --json option and a JSON request on standard input.");
		// The image is binary and the descriptor is JSON, so this command owns both streams: PNG
		// bytes on standard output and exactly one descriptor line on standard error.
		return helper::RunScreenshot(ReadRequest(
			"capture_invalid_request",
			"A versioned screenshot JSON request is required on standard input."));
	}
	if (arguments.command == L"capture") {
		RequireExactOptions(
			arguments,
			{ L"--json" },
			"capture requires exactly one --json option and a JSON request on standard input.");
		return helper::RunCapture(ReadRequest(
			"capture_invalid_request",
			"A versioned capture JSON request is required on standard input."));
	}

	throw FatalError("unsupported_command", "The requested helper command is not supported.");
}

} // namespace

int wmain(int argc, wchar_t* argv[]) {
	SetConsoleOutputCP(CP_UTF8);
	SetConsoleCP(CP_UTF8);

	try {
		return Run(ParseArguments(argc, argv));
	} catch (const FatalError& error) {
		std::cerr << helper::ErrorJson(
			error.Code(),
			error.what(),
			error.Hresult(),
			error.HasHresult())
			<< '\n';
		return 1;
	} catch (const std::exception& error) {
		std::cerr << helper::ErrorJson("unexpected_error", error.what()) << '\n';
		return 1;
	}
}
