#include "capture.h"

#include "capture_internal.h"
#include "support.h"
#include "version.h"

#include <windows.h>
#include <d3d10.h>
#include <dwmapi.h>
#include <roapi.h>
#include <winstring.h>
#include <wincodec.h>
#include <shlwapi.h>

#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace helper {
namespace {

using ABI::Windows::Foundation::IClosable;
using ABI::Windows::Graphics::SizeInt32;
using ABI::Windows::Graphics::Capture::IDirect3D11CaptureFrame;
using ABI::Windows::Graphics::Capture::IDirect3D11CaptureFramePool;
using ABI::Windows::Graphics::Capture::IDirect3D11CaptureFramePoolStatics;
using ABI::Windows::Graphics::Capture::IDirect3D11CaptureFramePoolStatics2;
using ABI::Windows::Graphics::Capture::IGraphicsCaptureItem;
using ABI::Windows::Graphics::Capture::IGraphicsCaptureSession;
using ABI::Windows::Graphics::Capture::IGraphicsCaptureSession2;
#ifdef ____x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession3_INTERFACE_DEFINED__
using ABI::Windows::Graphics::Capture::IGraphicsCaptureSession3;
#endif
#ifdef ____x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession4_INTERFACE_DEFINED__
using ABI::Windows::Graphics::Capture::IGraphicsCaptureSession4;
#endif
#ifdef ____x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession5_INTERFACE_DEFINED__
using ABI::Windows::Graphics::Capture::IGraphicsCaptureSession5;
#endif
using ABI::Windows::Graphics::DirectX::DirectXPixelFormat;
using ABI::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
using ABI::Windows::Graphics::DirectX::Direct3D11::IDirect3DSurface;

constexpr int kFramePoolBuffers = 2;
constexpr int kPollIntervalMilliseconds = 2;

/// Windows 10 version 1903 is the floor for picker-free CreateForWindow.
constexpr DWORD kMinimumCaptureBuild = 18362;

[[noreturn]] void Unavailable(std::string message, HRESULT hresult) {
	throw CaptureError(kStatusUnavailable, "capture_unavailable", std::move(message), hresult);
}

[[noreturn]] void Failed(std::string message, HRESULT hresult) {
	throw CaptureError(kStatusError, "capture_failed", std::move(message), hresult);
}

void Check(HRESULT result, const char* message) {
	if (FAILED(result)) {
		Failed(message, result);
	}
}

class HStringHandle final {
public:
	explicit HStringHandle(const wchar_t* value) {
		size_t length = 0;
		while (value[length] != L'\0') {
			++length;
		}
		const HRESULT result =
			WindowsCreateString(value, static_cast<UINT32>(length), &value_);
		if (FAILED(result)) {
			Failed("Could not create a Windows Runtime class name string.", result);
		}
	}

	~HStringHandle() {
		if (value_ != nullptr) {
			WindowsDeleteString(value_);
		}
	}

	HStringHandle(const HStringHandle&) = delete;
	HStringHandle& operator=(const HStringHandle&) = delete;

	HSTRING Get() const noexcept { return value_; }

private:
	HSTRING value_ = nullptr;
};

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/// A deliberately small strict reader for the two capture requests. It accepts one object with
/// scalar members plus one nested object, which is the entire shape of this protocol; anything
/// else is refused rather than tolerated.
class RequestReader final {
public:
	explicit RequestReader(std::string_view input) : input_(input) {}

	void Parse() {
		if (input_.size() > kMaximumCaptureRequestBytes) {
			Invalid("The capture request is too large.");
		}
		SkipWhitespace();
		Expect('{');
		ReadMembers(root_, 0);
		SkipWhitespace();
		if (position_ != input_.size()) {
			Invalid("Unexpected content after the capture request.");
		}
	}

	bool Has(std::string_view name) const { return Find(root_, name) != nullptr; }

	std::int64_t Integer(std::string_view name) const {
		const Member* member = Require(root_, name);
		if (member->kind != Kind::Number) {
			Invalid("A capture request field must be a number.");
		}
		return static_cast<std::int64_t>(member->number);
	}

	double Number(std::string_view name, double fallback) const {
		const Member* member = Find(root_, name);
		if (member == nullptr) {
			return fallback;
		}
		if (member->kind != Kind::Number) {
			Invalid("A capture request field must be a number.");
		}
		return member->number;
	}

	bool Boolean(std::string_view name, bool fallback) const {
		const Member* member = Find(root_, name);
		if (member == nullptr) {
			return fallback;
		}
		if (member->kind != Kind::Boolean) {
			Invalid("A capture request field must be a boolean.");
		}
		return member->boolean;
	}

	/// Selects the one nested object this request carries, refusing an unknown body name.
	void Enter(std::string_view name) {
		const Member* member = Require(root_, name);
		if (member->kind != Kind::Object) {
			Invalid("The capture request body must be an object.");
		}
		// The body lives inside the root's own storage, so it has to be copied out before the root
		// is replaced; assigning directly would destroy the source mid-copy.
		std::vector<Member> body = member->members;
		root_ = std::move(body);
	}

	void RequireOnly(std::initializer_list<std::string_view> allowed) const {
		for (const Member& member : root_) {
			bool known = false;
			for (const auto& name : allowed) {
				known = known || member.name == name;
			}
			if (!known) {
				Invalid("The capture request contains an unknown field.");
			}
		}
	}

	[[noreturn]] static void Invalid(std::string message) {
		throw CaptureError(kStatusError, "capture_invalid_request", std::move(message));
	}

private:
	enum class Kind { Null, Boolean, Number, String, Object };

	struct Member {
		std::string name;
		Kind kind = Kind::Null;
		bool boolean = false;
		double number = 0;
		std::string text;
		std::vector<Member> members;
	};

	static const Member* Find(const std::vector<Member>& members, std::string_view name) {
		for (const Member& member : members) {
			if (member.name == name) {
				return &member;
			}
		}
		return nullptr;
	}

	static const Member* Require(const std::vector<Member>& members, std::string_view name) {
		const Member* member = Find(members, name);
		if (member == nullptr) {
			Invalid("The capture request is missing a required field.");
		}
		return member;
	}

	void SkipWhitespace() {
		while (position_ < input_.size()) {
			const char character = input_[position_];
			if (character != ' ' && character != '\t' && character != '\r' && character != '\n') {
				return;
			}
			++position_;
		}
	}

	char Take() {
		if (position_ == input_.size()) {
			Invalid("The capture request ended unexpectedly.");
		}
		return input_[position_++];
	}

	void Expect(char expected) {
		SkipWhitespace();
		if (Take() != expected) {
			Invalid("The capture request has invalid JSON syntax.");
		}
	}

	void ReadMembers(std::vector<Member>& target, int depth) {
		if (depth > 4) {
			Invalid("The capture request is nested too deeply.");
		}
		SkipWhitespace();
		if (position_ < input_.size() && input_[position_] == '}') {
			++position_;
			return;
		}
		for (;;) {
			Member member;
			SkipWhitespace();
			member.name = ReadString();
			Expect(':');
			ReadValue(member, depth);
			if (Find(target, member.name) != nullptr) {
				Invalid("The capture request repeats a field.");
			}
			target.push_back(std::move(member));

			SkipWhitespace();
			const char separator = Take();
			if (separator == '}') {
				return;
			}
			if (separator != ',') {
				Invalid("The capture request has invalid JSON syntax.");
			}
		}
	}

	void ReadValue(Member& member, int depth) {
		SkipWhitespace();
		if (position_ == input_.size()) {
			Invalid("The capture request ended unexpectedly.");
		}
		const char character = input_[position_];
		if (character == '{') {
			++position_;
			member.kind = Kind::Object;
			ReadMembers(member.members, depth + 1);
			return;
		}
		if (character == '"') {
			member.kind = Kind::String;
			member.text = ReadString();
			return;
		}
		if (input_.compare(position_, 4, "true") == 0) {
			position_ += 4;
			member.kind = Kind::Boolean;
			member.boolean = true;
			return;
		}
		if (input_.compare(position_, 5, "false") == 0) {
			position_ += 5;
			member.kind = Kind::Boolean;
			member.boolean = false;
			return;
		}
		if (input_.compare(position_, 4, "null") == 0) {
			position_ += 4;
			member.kind = Kind::Null;
			return;
		}
		member.kind = Kind::Number;
		member.number = ReadNumber();
	}

	std::string ReadString() {
		Expect('"');
		std::string value;
		for (;;) {
			const char character = Take();
			if (character == '"') {
				return value;
			}
			if (character == '\\') {
				const char escape = Take();
				switch (escape) {
				case '"': value += '"'; break;
				case '\\': value += '\\'; break;
				case '/': value += '/'; break;
				case 'b': value += '\b'; break;
				case 'f': value += '\f'; break;
				case 'n': value += '\n'; break;
				case 'r': value += '\r'; break;
				case 't': value += '\t'; break;
				default: Invalid("The capture request has an unsupported string escape.");
				}
				continue;
			}
			if (value.size() > 512) {
				Invalid("A capture request string is too long.");
			}
			value += character;
		}
	}

	double ReadNumber() {
		const size_t start = position_;
		while (position_ < input_.size()) {
			const char character = input_[position_];
			const bool numeric = (character >= '0' && character <= '9') || character == '-'
				|| character == '+' || character == '.' || character == 'e' || character == 'E';
			if (!numeric) {
				break;
			}
			++position_;
		}
		if (position_ == start) {
			Invalid("The capture request has invalid JSON syntax.");
		}
		const std::string text(input_.substr(start, position_ - start));
		char* end = nullptr;
		const double value = std::strtod(text.c_str(), &end);
		if (end == nullptr || *end != '\0') {
			Invalid("The capture request has an unreadable number.");
		}
		return value;
	}

	std::string_view input_;
	size_t position_ = 0;
	std::vector<Member> root_;
};

struct CaptureRequest {
	HWND window = nullptr;
	double scale = 1;
	int maximum_dimension = 0;
	bool include_cursor = false;
	int frames_per_second = 30;
	std::int64_t average_bitrate = 12000000;
	int timeout_milliseconds = 10000;
};

HWND RequireHandle(std::int64_t handle) {
	if (handle <= 0 ||
		static_cast<std::uint64_t>(handle) >
			static_cast<std::uint64_t>((std::numeric_limits<uintptr_t>::max)())) {
		RequestReader::Invalid("handle must be a positive native window handle.");
	}
	return reinterpret_cast<HWND>(static_cast<uintptr_t>(handle));
}

CaptureRequest ParseRequest(const std::string& json, bool streaming) {
	RequestReader reader(json);
	reader.Parse();
	reader.RequireOnly({ "schemaVersion", "handle", streaming ? "capture" : "screenshot" });
	if (reader.Integer("schemaVersion") != 1) {
		throw CaptureError(
			kStatusError,
			"capture_schema_incompatible",
			"The capture request schemaVersion must be 1.");
	}

	CaptureRequest request;
	request.window = RequireHandle(reader.Integer("handle"));
	reader.Enter(streaming ? "capture" : "screenshot");
	if (streaming) {
		reader.RequireOnly({
			"framesPerSecond",
			"scale",
			"averageBitrate",
			"includeCursor",
			"timeoutMilliseconds",
		});
		request.frames_per_second = static_cast<int>(std::llround(std::clamp(
			reader.Number("framesPerSecond", 30.0),
			static_cast<double>(kMinimumFramesPerSecond),
			static_cast<double>(kMaximumFramesPerSecond))));
		request.average_bitrate = static_cast<std::int64_t>(std::llround(std::clamp(
			reader.Number("averageBitrate", 12000000.0),
			static_cast<double>(kMinimumBitrate),
			static_cast<double>(kMaximumBitrate))));
	} else {
		reader.RequireOnly({
			"scale",
			"maximumDimension",
			"includeCursor",
			"timeoutMilliseconds",
		});
		const double maximum = reader.Number("maximumDimension", 0.0);
		request.maximum_dimension = maximum <= 0
			? 0
			: static_cast<int>(std::llround(std::clamp(
				maximum,
				static_cast<double>(kMinimumCaptureDimension),
				static_cast<double>(kMaximumCaptureDimension))));
	}
	request.scale = std::clamp(reader.Number("scale", 1.0), 0.1, 1.0);
	request.include_cursor = reader.Boolean("includeCursor", false);
	request.timeout_milliseconds = static_cast<int>(std::llround(std::clamp(
		reader.Number("timeoutMilliseconds", 10000.0),
		1000.0,
		static_cast<double>(kMaximumStartupTimeoutMilliseconds))));
	return request;
}

// ---------------------------------------------------------------------------
// Status reporting
// ---------------------------------------------------------------------------

std::string StatusLine(
	const char* type,
	const char* status,
	bool ok,
	HWND window,
	const std::string& geometry,
	const std::string& capabilities,
	const char* reason,
	const std::string& detail,
	const std::string& error) {
	JsonObject root;
	root.Number("schemaVersion", 1);
	root.Boolean("ok", ok);
	root.String("helperVersion", Utf8(MOBILE_CANVAS_HELPER_VERSION));
	root.String("type", type);
	root.String("status", status);
	root.String("source", "windowsGraphicsCapture");
	if (!detail.empty()) {
		root.String("sourceDetail", detail);
	}
	if (reason != nullptr) {
		root.String("reason", reason);
	}
	root.Signed("handle", static_cast<std::int64_t>(reinterpret_cast<uintptr_t>(window)));
	if (!geometry.empty()) {
		root.Raw("geometry", geometry);
	}
	if (!capabilities.empty()) {
		root.Raw("capabilities", capabilities);
	}
	if (!error.empty()) {
		root.Raw("error", error);
	}
	return root.Finish();
}

} // namespace

CapturedFrame::~CapturedFrame() {
	Close();
}

void CapturedFrame::Close() noexcept {
	if (!source_frame) {
		return;
	}

	ComPtr<IClosable> closable;
	if (SUCCEEDED(source_frame->QueryInterface(
			__uuidof(IClosable),
			reinterpret_cast<void**>(closable.Put())))) {
		closable->Close();
	}
	source_frame.Reset();
	texture.Reset();
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

WindowGeometry ReadWindowGeometry(HWND window) {
	WindowGeometry geometry;
	if (window == nullptr || IsWindow(window) == FALSE) {
		return geometry;
	}
	geometry.window_exists = true;
	geometry.minimized = IsIconic(window) != FALSE;

	if (GetWindowRect(window, &geometry.frame) == FALSE) {
		geometry.window_exists = false;
		return geometry;
	}

	geometry.content = geometry.frame;
	RECT extended = {};
	if (SUCCEEDED(DwmGetWindowAttribute(
			window,
			DWMWA_EXTENDED_FRAME_BOUNDS,
			&extended,
			sizeof(extended)))
		&& extended.right > extended.left
		&& extended.bottom > extended.top) {
		// The visible window is smaller than its rectangle: since Windows 10 a top-level window
		// carries an invisible resize border, and cropping to the extended frame bounds is what
		// makes the picture and the coordinate origin agree with what a person sees.
		geometry.content = extended;
	}

	RECT client = {};
	POINT origin = { 0, 0 };
	if (GetClientRect(window, &client) != FALSE && ClientToScreen(window, &origin) != FALSE) {
		geometry.client.left = origin.x;
		geometry.client.top = origin.y;
		geometry.client.right = origin.x + (client.right - client.left);
		geometry.client.bottom = origin.y + (client.bottom - client.top);
	} else {
		geometry.client = geometry.frame;
	}

	const UINT dpi = GetDpiForWindow(window);
	geometry.dpi = dpi == 0 ? 96 : dpi;

	DWORD affinity = 0;
	if (GetWindowDisplayAffinity(window, &affinity) != FALSE) {
		geometry.excluded_from_capture = affinity != WDA_NONE;
	}
	return geometry;
}

CaptureLayout ComputeLayout(
	const WindowGeometry& geometry,
	int surface_width,
	int surface_height,
	double scale,
	int maximum_dimension,
	bool even_dimensions) {
	CaptureLayout layout;
	layout.surface_width = surface_width;
	layout.surface_height = surface_height;
	const int frame_width = geometry.frame.right - geometry.frame.left;
	const int frame_height = geometry.frame.bottom - geometry.frame.top;
	const int content_width = geometry.content.right - geometry.content.left;
	const int content_height = geometry.content.bottom - geometry.content.top;

	// A window surface may be sized to the whole window rectangle or already to the visible
	// content. Rather than assuming which, compare the two and crop only when there is a border to
	// remove; anything else is clamped so a surprising surface size degrades into a smaller
	// picture rather than into a read past its edge.
	if (surface_width >= frame_width
		&& surface_height >= frame_height
		&& frame_width > 0
		&& frame_height > 0) {
		layout.offset_x = geometry.content.left - geometry.frame.left;
		layout.offset_y = geometry.content.top - geometry.frame.top;
	}
	layout.offset_x = std::clamp(layout.offset_x, 0, (std::max)(surface_width - 1, 0));
	layout.offset_y = std::clamp(layout.offset_y, 0, (std::max)(surface_height - 1, 0));
	layout.content_width = (std::min)(content_width, surface_width - layout.offset_x);
	layout.content_height = (std::min)(content_height, surface_height - layout.offset_y);
	layout.content_width = (std::max)(layout.content_width, 0);
	layout.content_height = (std::max)(layout.content_height, 0);

	double effective = std::clamp(scale, 0.1, 1.0);
	if (maximum_dimension > 0) {
		const int longest = (std::max)(layout.content_width, layout.content_height);
		if (longest > 0 && static_cast<double>(longest) * effective > maximum_dimension) {
			effective = static_cast<double>(maximum_dimension) / longest;
		}
	}

	layout.capture_width =
		static_cast<int>(std::llround(layout.content_width * effective));
	layout.capture_height =
		static_cast<int>(std::llround(layout.content_height * effective));
	layout.capture_width = std::clamp(layout.capture_width, 1, kMaximumCaptureDimension);
	layout.capture_height = std::clamp(layout.capture_height, 1, kMaximumCaptureDimension);
	if (even_dimensions) {
		// NV12 is 4:2:0, so an odd edge has no chroma sample to pair with.
		layout.capture_width = (std::max)(layout.capture_width & ~1, 2);
		layout.capture_height = (std::max)(layout.capture_height & ~1, 2);
	}
	layout.scale = layout.content_width > 0
		? static_cast<double>(layout.capture_width) / layout.content_width
		: effective;
	return layout;
}

std::string GeometryJson(const WindowGeometry& geometry, const CaptureLayout& layout) {
	JsonObject visible_offset;
	visible_offset.Signed("x", layout.offset_x);
	visible_offset.Signed("y", layout.offset_y);

	JsonObject frame_offset;
	frame_offset.Signed("x", geometry.frame.left - geometry.content.left);
	frame_offset.Signed("y", geometry.frame.top - geometry.content.top);

	JsonObject client_offset;
	client_offset.Signed("x", geometry.client.left - geometry.content.left);
	client_offset.Signed("y", geometry.client.top - geometry.content.top);

	const auto bounds = [](const RECT& value) {
		JsonObject object;
		object.Signed("left", value.left);
		object.Signed("top", value.top);
		object.Signed("width", (std::max)(value.right - value.left, 0L));
		object.Signed("height", (std::max)(value.bottom - value.top, 0L));
		return object.Finish();
	};

	RECT content = geometry.content;
	content.right = content.left + layout.content_width;
	content.bottom = content.top + layout.content_height;

	JsonObject root;
	root.Signed("contentWidth", layout.content_width);
	root.Signed("contentHeight", layout.content_height);
	root.Signed("captureWidth", layout.capture_width);
	root.Signed("captureHeight", layout.capture_height);
	root.Double("scale", layout.scale);
	root.Signed("surfaceWidth", layout.surface_width);
	root.Signed("surfaceHeight", layout.surface_height);
	root.Raw("visibleOffset", visible_offset.Finish());
	root.Raw("frameOffset", frame_offset.Finish());
	root.Raw("clientOffset", client_offset.Finish());
	root.Signed("clientWidth", (std::max)(geometry.client.right - geometry.client.left, 0L));
	root.Signed("clientHeight", (std::max)(geometry.client.bottom - geometry.client.top, 0L));
	root.Raw("contentScreenBounds", bounds(content));
	root.Raw("windowScreenBounds", bounds(geometry.frame));
	root.Raw("clientScreenBounds", bounds(geometry.client));
	root.Number("dpi", geometry.dpi);
	root.Double("dpiScale", geometry.dpi / 96.0);
	root.Boolean("minimized", geometry.minimized);
	return root.Finish();
}

std::string CapabilitiesJson(const CaptureCapabilities& capabilities) {
	JsonObject root;
	root.Boolean("freeThreadedFramePool", capabilities.free_threaded_frame_pool);
	root.Boolean("cursorCaptureToggle", capabilities.cursor_capture_toggle);
	root.Boolean("borderRequiredToggle", capabilities.border_required_toggle);
	root.Boolean("secondaryWindowCapture", capabilities.secondary_window_capture);
	root.Boolean("dirtyRegionMode", capabilities.dirty_region_mode);
	root.Boolean("cursorCaptured", capabilities.cursor_captured);
	root.Boolean("borderRequired", capabilities.border_required);
	root.Boolean("hardwareEncoder", capabilities.hardware_encoder);
	root.OptionalString("encoder", capabilities.encoder);
	root.OptionalString("adapter", capabilities.adapter);
	return root.Finish();
}

// ---------------------------------------------------------------------------
// Direct3D
// ---------------------------------------------------------------------------

void GraphicsDevice::Start() {
	static const D3D_FEATURE_LEVEL levels[] = {
		D3D_FEATURE_LEVEL_11_1,
		D3D_FEATURE_LEVEL_11_0,
		D3D_FEATURE_LEVEL_10_1,
		D3D_FEATURE_LEVEL_10_0,
	};
	const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;

	D3D_FEATURE_LEVEL level = D3D_FEATURE_LEVEL_11_0;
	HRESULT result = D3D11CreateDevice(
		nullptr,
		D3D_DRIVER_TYPE_HARDWARE,
		nullptr,
		flags,
		levels,
		ARRAYSIZE(levels),
		D3D11_SDK_VERSION,
		device_.Put(),
		&level,
		context_.Put());
	if (FAILED(result)) {
		// A machine with no usable GPU, or one whose driver refuses video support, still has to
		// produce a picture: WARP is slower but honest, and the descriptor names the adapter.
		result = D3D11CreateDevice(
			nullptr,
			D3D_DRIVER_TYPE_WARP,
			nullptr,
			D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
			levels,
			ARRAYSIZE(levels),
			D3D11_SDK_VERSION,
			device_.Put(),
			&level,
			context_.Put());
	}
	if (FAILED(result)) {
		Unavailable("Could not create a Direct3D 11 device for capture.", result);
	}

	// Frames are polled on one thread and encoded on another, and Media Foundation may touch the
	// device from its own worker threads.
	ComPtr<ID3D10Multithread> multithread;
	if (SUCCEEDED(device_->QueryInterface(
			__uuidof(ID3D10Multithread),
			reinterpret_cast<void**>(multithread.Put())))) {
		multithread->SetMultithreadProtected(TRUE);
	}

	ComPtr<IDXGIDevice> dxgi_device;
	Check(
		device_->QueryInterface(
			__uuidof(IDXGIDevice),
			reinterpret_cast<void**>(dxgi_device.Put())),
		"Could not obtain the DXGI device for capture.");

	ComPtr<IDXGIAdapter> adapter;
	if (SUCCEEDED(dxgi_device->GetAdapter(adapter.Put()))) {
		DXGI_ADAPTER_DESC description = {};
		if (SUCCEEDED(adapter->GetDesc(&description))) {
			adapter_ = description.AdapterLuid;
			adapter_description_ = description.Description;
		}
	}

	ComPtr<IInspectable> inspectable;
	Check(
		CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.Get(), inspectable.Put()),
		"Could not project the Direct3D device into the Windows Runtime.");
	Check(
		inspectable->QueryInterface(
			__uuidof(IDirect3DDevice),
			reinterpret_cast<void**>(runtime_.Put())),
		"Could not obtain the Windows Runtime Direct3D device.");
}

// ---------------------------------------------------------------------------
// Windows.Graphics.Capture
// ---------------------------------------------------------------------------

WindowCapture::~WindowCapture() {
	Stop();
}

void WindowCapture::Start(GraphicsDevice& device, HWND window, bool include_cursor) {
	OSVERSIONINFOEXW version = {};
	version.dwOSVersionInfoSize = sizeof(version);
#pragma warning(push)
#pragma warning(disable : 4996)
	if (GetVersionExW(reinterpret_cast<OSVERSIONINFOW*>(&version)) != FALSE &&
		version.dwBuildNumber < kMinimumCaptureBuild) {
		Unavailable(
			"Windows.Graphics.Capture needs Windows 10 version 1903 or later to capture a window "
			"without a picker.",
			HRESULT_FROM_WIN32(ERROR_OLD_WIN_VERSION));
	}
#pragma warning(pop)

	const HStringHandle item_class(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem);
	ComPtr<IGraphicsCaptureItemInterop> interop;
	HRESULT result = RoGetActivationFactory(
		item_class.Get(),
		__uuidof(IGraphicsCaptureItemInterop),
		reinterpret_cast<void**>(interop.Put()));
	if (FAILED(result)) {
		Unavailable("Windows.Graphics.Capture is not available on this machine.", result);
	}

	result = interop->CreateForWindow(
		window,
		__uuidof(IGraphicsCaptureItem),
		reinterpret_cast<void**>(item_.Put()));
	if (FAILED(result)) {
		if (IsWindow(window) == FALSE) {
			throw CaptureError(
				kStatusClosed,
				"capture_window_closed",
				"That window closed before capture could start.",
				result);
		}
		throw CaptureError(
			kStatusProtected,
			"capture_refused",
			"Windows refused to create a capture item for that window. A window that excludes "
			"itself from capture, or that belongs to a protected process, cannot be captured.",
			result);
	}

	SizeInt32 size = {};
	Check(item_->get_Size(&size), "Could not read the capture item size.");
	item_width_ = size.Width;
	item_height_ = size.Height;
	if (item_width_ <= 0 || item_height_ <= 0) {
		throw CaptureError(
			kStatusMinimized,
			"capture_no_content",
			"That window currently has no visible content to capture.");
	}

	const HStringHandle pool_class(
		RuntimeClass_Windows_Graphics_Capture_Direct3D11CaptureFramePool);
	ComPtr<IDirect3D11CaptureFramePoolStatics2> free_threaded;
	if (SUCCEEDED(RoGetActivationFactory(
			pool_class.Get(),
			__uuidof(IDirect3D11CaptureFramePoolStatics2),
			reinterpret_cast<void**>(free_threaded.Put())))) {
		capabilities_.free_threaded_frame_pool = true;
		Check(
			free_threaded->CreateFreeThreaded(
				device.Runtime(),
				DirectXPixelFormat::DirectXPixelFormat_B8G8R8A8UIntNormalized,
				kFramePoolBuffers,
				size,
				pool_.Put()),
			"Could not create a free-threaded capture frame pool.");
	} else {
		// Older builds have no free-threaded pool. The single-threaded one needs a dispatcher on
		// this thread, which a console helper does not have, so this is reported rather than
		// worked around with a hidden message loop.
		ComPtr<IDirect3D11CaptureFramePoolStatics> statics;
		result = RoGetActivationFactory(
			pool_class.Get(),
			__uuidof(IDirect3D11CaptureFramePoolStatics),
			reinterpret_cast<void**>(statics.Put()));
		if (FAILED(result)) {
			Unavailable("Windows.Graphics.Capture frame pools are unavailable.", result);
		}
		result = statics->Create(
			device.Runtime(),
			DirectXPixelFormat::DirectXPixelFormat_B8G8R8A8UIntNormalized,
			kFramePoolBuffers,
			size,
			pool_.Put());
		if (FAILED(result)) {
			Unavailable(
				"This Windows build offers no free-threaded capture frame pool, and the "
				"single-threaded one needs a dispatcher this helper does not run.",
				result);
		}
	}

	Check(pool_->CreateCaptureSession(item_.Get(), session_.Put()), "Could not start capture.");

	ComPtr<IGraphicsCaptureSession2> cursor;
	if (SUCCEEDED(session_->QueryInterface(
			__uuidof(IGraphicsCaptureSession2),
			reinterpret_cast<void**>(cursor.Put())))) {
		capabilities_.cursor_capture_toggle = true;
		cursor->put_IsCursorCaptureEnabled(include_cursor ? TRUE : FALSE);
		capabilities_.cursor_captured = include_cursor;
	} else {
		capabilities_.cursor_captured = true;
	}

	// The interfaces below arrived in later Windows SDKs than picker-free capture itself. They are
	// guarded on the generated ABI header's own definition macro so this file still compiles
	// against an older SDK, and every one of them is reported rather than required.
#ifdef ____x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession3_INTERFACE_DEFINED__
	ComPtr<IGraphicsCaptureSession3> border;
	if (SUCCEEDED(session_->QueryInterface(
			__uuidof(IGraphicsCaptureSession3),
			reinterpret_cast<void**>(border.Put())))) {
		// The capability is detected but never used to switch the indicator off. Hiding the fact
		// that a window is being captured is not something this product does behind a user's back.
		capabilities_.border_required_toggle = true;
		boolean required = TRUE;
		if (SUCCEEDED(border->get_IsBorderRequired(&required))) {
			capabilities_.border_required = required != FALSE;
		}
	}
#endif

#ifdef ____x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession4_INTERFACE_DEFINED__
	ComPtr<IGraphicsCaptureSession4> secondary;
	capabilities_.secondary_window_capture = SUCCEEDED(session_->QueryInterface(
		__uuidof(IGraphicsCaptureSession4),
		reinterpret_cast<void**>(secondary.Put())));
#endif

#ifdef ____x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession5_INTERFACE_DEFINED__
	ComPtr<IGraphicsCaptureSession5> dirty;
	capabilities_.dirty_region_mode = SUCCEEDED(session_->QueryInterface(
		__uuidof(IGraphicsCaptureSession5),
		reinterpret_cast<void**>(dirty.Put())));
#endif

	Check(session_->StartCapture(), "Windows refused to start capturing that window.");
	started_ = true;
}

void WindowCapture::Stop() {
	if (session_) {
		ComPtr<IClosable> closable;
		if (SUCCEEDED(session_->QueryInterface(
				__uuidof(IClosable),
				reinterpret_cast<void**>(closable.Put())))) {
			closable->Close();
		}
		session_.Reset();
	}
	if (pool_) {
		ComPtr<IClosable> closable;
		if (SUCCEEDED(pool_->QueryInterface(
				__uuidof(IClosable),
				reinterpret_cast<void**>(closable.Put())))) {
			closable->Close();
		}
		pool_.Reset();
	}
	item_.Reset();
	started_ = false;
}

bool WindowCapture::TryAcquire(
	GraphicsDevice& device,
	const WindowGeometry& geometry,
	CapturedFrame& frame,
	int timeout_milliseconds) {
	(void)device;
	(void)geometry;
	if (!started_) {
		return false;
	}

	const auto deadline = std::chrono::steady_clock::now()
		+ std::chrono::milliseconds((std::max)(timeout_milliseconds, 0));
	for (;;) {
		ComPtr<IDirect3D11CaptureFrame> newest;
		for (;;) {
			ComPtr<IDirect3D11CaptureFrame> candidate;
			if (FAILED(pool_->TryGetNextFrame(candidate.Put())) || !candidate) {
				break;
			}
			if (newest) {
				// Only the newest frame is worth encoding. Older ones are closed at once so the
				// pool never starves behind a slow encoder.
				ComPtr<IClosable> stale;
				if (SUCCEEDED(newest->QueryInterface(
						__uuidof(IClosable),
						reinterpret_cast<void**>(stale.Put())))) {
					stale->Close();
				}
			}
			newest = std::move(candidate);
		}

		if (newest) {
			frame.Close();
			SizeInt32 content = {};
			newest->get_ContentSize(&content);
			ABI::Windows::Foundation::TimeSpan timestamp = {};
			newest->get_SystemRelativeTime(&timestamp);

			ComPtr<IDirect3DSurface> surface;
			Check(newest->get_Surface(surface.Put()), "Could not read a captured frame surface.");
			ComPtr<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;
			Check(
				surface->QueryInterface(
					__uuidof(Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess),
					reinterpret_cast<void**>(access.Put())),
				"Could not obtain the Direct3D texture behind a captured frame.");
			ComPtr<ID3D11Texture2D> texture;
			Check(
				access->GetInterface(
					__uuidof(ID3D11Texture2D),
					reinterpret_cast<void**>(texture.Put())),
				"Could not obtain the Direct3D texture behind a captured frame.");

			D3D11_TEXTURE2D_DESC description = {};
			texture->GetDesc(&description);
			frame.texture = std::move(texture);
			frame.surface_width = content.Width > 0
				? content.Width
				: static_cast<int>(description.Width);
			frame.surface_height = content.Height > 0
				? content.Height
				: static_cast<int>(description.Height);
			frame.system_relative_time = timestamp.Duration;
			frame.source_frame = std::move(newest);
			return true;
		}

		if (std::chrono::steady_clock::now() >= deadline) {
			return false;
		}
		std::this_thread::sleep_for(std::chrono::milliseconds(kPollIntervalMilliseconds));
	}
}

ComPtr<ID3D11Texture2D> CropFrame(
	GraphicsDevice& device,
	const CapturedFrame& frame,
	const CaptureLayout& layout,
	bool cpu_readable) {
	D3D11_TEXTURE2D_DESC source = {};
	frame.texture->GetDesc(&source);

	D3D11_TEXTURE2D_DESC target = {};
	target.Width = static_cast<UINT>(layout.content_width);
	target.Height = static_cast<UINT>(layout.content_height);
	target.MipLevels = 1;
	target.ArraySize = 1;
	target.Format = source.Format;
	target.SampleDesc.Count = 1;
	target.Usage = cpu_readable ? D3D11_USAGE_STAGING : D3D11_USAGE_DEFAULT;
	target.BindFlags = cpu_readable
		? 0
		: (D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET);
	target.CPUAccessFlags = cpu_readable ? D3D11_CPU_ACCESS_READ : 0;

	ComPtr<ID3D11Texture2D> cropped;
	Check(
		device.Device()->CreateTexture2D(&target, nullptr, cropped.Put()),
		"Could not allocate the cropped capture texture.");

	D3D11_BOX box = {};
	box.left = static_cast<UINT>(layout.offset_x);
	box.top = static_cast<UINT>(layout.offset_y);
	box.front = 0;
	box.right = box.left + target.Width;
	box.bottom = box.top + target.Height;
	box.back = 1;
	if (box.right > source.Width || box.bottom > source.Height) {
		throw CaptureError(
			kStatusError,
			"capture_geometry_mismatch",
			"The window's visible area no longer fits inside its capture surface.");
	}

	device.Context()->CopySubresourceRegion(
		cropped.Get(),
		0,
		0,
		0,
		0,
		frame.texture.Get(),
		0,
		&box);
	device.Context()->Flush();
	return cropped;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

std::vector<std::uint8_t> EncodePng(
	GraphicsDevice& device,
	ID3D11Texture2D* texture,
	int source_width,
	int source_height,
	int target_width,
	int target_height) {
	D3D11_MAPPED_SUBRESOURCE mapped = {};
	Check(
		device.Context()->Map(texture, 0, D3D11_MAP_READ, 0, &mapped),
		"Could not read the captured pixels.");

	std::vector<std::uint8_t> pixels;
	const size_t stride = static_cast<size_t>(source_width) * 4;
	pixels.resize(stride * static_cast<size_t>(source_height));
	const auto* row = static_cast<const std::uint8_t*>(mapped.pData);
	for (int y = 0; y < source_height; ++y) {
		std::memcpy(pixels.data() + (stride * static_cast<size_t>(y)), row, stride);
		row += mapped.RowPitch;
	}
	device.Context()->Unmap(texture, 0);

	return EncodePngPixels(
		pixels.data(),
		source_width,
		source_height,
		stride,
		target_width,
		target_height);
}

std::vector<std::uint8_t> EncodePngPixels(
	const std::uint8_t* pixels,
	int source_width,
	int source_height,
	std::size_t stride,
	int target_width,
	int target_height) {
	ComPtr<IWICImagingFactory> factory;
	Check(
		CoCreateInstance(
			CLSID_WICImagingFactory,
			nullptr,
			CLSCTX_INPROC_SERVER,
			__uuidof(IWICImagingFactory),
			reinterpret_cast<void**>(factory.Put())),
		"Could not create the Windows Imaging Component factory.");

	ComPtr<IWICBitmap> bitmap;
	Check(
		factory->CreateBitmapFromMemory(
			static_cast<UINT>(source_width),
			static_cast<UINT>(source_height),
			GUID_WICPixelFormat32bppBGRA,
			static_cast<UINT>(stride),
			static_cast<UINT>(stride * static_cast<std::size_t>(source_height)),
			const_cast<BYTE*>(pixels),
			bitmap.Put()),
		"Could not wrap the captured pixels for encoding.");

	ComPtr<IWICBitmapScaler> scaler;
	IWICBitmapSource* source = bitmap.Get();
	if (target_width != source_width || target_height != source_height) {
		Check(factory->CreateBitmapScaler(scaler.Put()), "Could not scale the screenshot.");
		Check(
			scaler->Initialize(
				bitmap.Get(),
				static_cast<UINT>(target_width),
				static_cast<UINT>(target_height),
				WICBitmapInterpolationModeFant),
			"Could not scale the screenshot.");
		source = scaler.Get();
	}

	ComPtr<IStream> stream;
	Check(
		CreateStreamOnHGlobal(nullptr, TRUE, stream.Put()),
		"Could not allocate the screenshot buffer.");

	ComPtr<IWICBitmapEncoder> encoder;
	Check(
		factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.Put()),
		"Could not create the PNG encoder.");
	Check(
		encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache),
		"Could not initialize the PNG encoder.");

	ComPtr<IWICBitmapFrameEncode> frame;
	ComPtr<IPropertyBag2> properties;
	Check(
		encoder->CreateNewFrame(frame.Put(), properties.Put()),
		"Could not create the PNG frame.");
	Check(frame->Initialize(properties.Get()), "Could not initialize the PNG frame.");
	Check(
		frame->SetSize(static_cast<UINT>(target_width), static_cast<UINT>(target_height)),
		"Could not size the PNG frame.");
	WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
	Check(frame->SetPixelFormat(&format), "Could not set the PNG pixel format.");
	Check(frame->WriteSource(source, nullptr), "Could not write the PNG pixels.");
	Check(frame->Commit(), "Could not finish the PNG frame.");
	Check(encoder->Commit(), "Could not finish the PNG image.");

	HGLOBAL memory = nullptr;
	Check(GetHGlobalFromStream(stream.Get(), &memory), "Could not read the encoded PNG.");
	const auto size = static_cast<size_t>(GlobalSize(memory));
	const auto* bytes = static_cast<const std::uint8_t*>(GlobalLock(memory));
	if (bytes == nullptr) {
		Failed("Could not read the encoded PNG.", E_FAIL);
	}
	std::vector<std::uint8_t> image(bytes, bytes + size);
	GlobalUnlock(memory);
	return image;
}

/// The explicitly degraded still-capture path.
///
/// It is used only when Windows.Graphics.Capture is unavailable on the machine, never as a quiet
/// substitute for it, and the descriptor says so. `PrintWindow` asks the window to redraw itself
/// into a bitmap, which misses hardware overlays, protected content, and anything a compositor drew
/// on the window's behalf — so a caller has to know that is what it is looking at.
std::vector<std::uint8_t> PrintWindowPng(
	HWND window,
	const WindowGeometry& geometry,
	const CaptureLayout& layout) {
	const int width = geometry.frame.right - geometry.frame.left;
	const int height = geometry.frame.bottom - geometry.frame.top;
	if (width < 1 || height < 1) {
		throw CaptureError(
			kStatusMinimized,
			"capture_no_content",
			"That window currently has no visible content to capture.");
	}

	const HDC screen = GetDC(nullptr);
	if (screen == nullptr) {
		Failed("Could not obtain a device context for the fallback capture.", HresultFromLastError());
	}
	const HDC memory = CreateCompatibleDC(screen);
	if (memory == nullptr) {
		ReleaseDC(nullptr, screen);
		Failed("Could not create a bitmap for the fallback capture.", HresultFromLastError());
	}

	BITMAPINFO info = {};
	info.bmiHeader.biSize = sizeof(info.bmiHeader);
	info.bmiHeader.biWidth = width;
	// Negative height asks for a top-down bitmap, so row zero is the top of the window rather than
	// its bottom, which is what the rest of this file assumes.
	info.bmiHeader.biHeight = -height;
	info.bmiHeader.biPlanes = 1;
	info.bmiHeader.biBitCount = 32;
	info.bmiHeader.biCompression = BI_RGB;

	void* bits = nullptr;
	const HBITMAP bitmap = CreateDIBSection(memory, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
	if (bitmap == nullptr || bits == nullptr) {
		DeleteDC(memory);
		ReleaseDC(nullptr, screen);
		Failed("Could not allocate the fallback capture bitmap.", HresultFromLastError());
	}

	const HGDIOBJ previous = SelectObject(memory, bitmap);
	// PW_RENDERFULLCONTENT asks for composited content that a plain redraw would miss.
	const BOOL printed = PrintWindow(window, memory, 0x00000002);
	SelectObject(memory, previous);

	// The crop is copied out before the GDI objects are released, so encoding cannot leave a
	// device context or a bitmap behind if it fails.
	const std::size_t source_stride = static_cast<std::size_t>(width) * 4;
	const std::size_t row_bytes = static_cast<std::size_t>(layout.content_width) * 4;
	std::vector<std::uint8_t> pixels;
	if (printed != FALSE) {
		pixels.resize(row_bytes * static_cast<std::size_t>(layout.content_height));
		const auto* rows = static_cast<const std::uint8_t*>(bits)
			+ (static_cast<std::size_t>(layout.offset_y) * source_stride)
			+ (static_cast<std::size_t>(layout.offset_x) * 4);
		for (int row = 0; row < layout.content_height; ++row) {
			std::memcpy(
				pixels.data() + (row_bytes * static_cast<std::size_t>(row)),
				rows + (source_stride * static_cast<std::size_t>(row)),
				row_bytes);
		}
	}

	DeleteObject(bitmap);
	DeleteDC(memory);
	ReleaseDC(nullptr, screen);
	if (printed == FALSE) {
		Failed("Windows refused to redraw that window into a bitmap.", HresultFromLastError());
	}

	return EncodePngPixels(
		pixels.data(),
		layout.content_width,
		layout.content_height,
		row_bytes,
		layout.capture_width,
		layout.capture_height);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

int RunScreenshot(const std::string& request_json) {
	std::string geometry_json;
	std::string capabilities_json;
	HWND window = nullptr;
	try {
		const CaptureRequest request = ParseRequest(request_json, /*streaming=*/false);
		window = request.window;

		Apartment apartment;
		WindowGeometry geometry = ReadWindowGeometry(request.window);
		if (!geometry.window_exists) {
			throw CaptureError(kStatusClosed, "capture_window_closed", "That window no longer exists.");
		}
		if (geometry.minimized) {
			throw CaptureError(
				kStatusMinimized,
				"capture_minimized",
				"That window is minimized, so it has no visible content to capture.");
		}

		GraphicsDevice device;
		device.Start();

		WindowCapture capture;
		CaptureCapabilities capabilities;
		CaptureLayout layout;
		std::vector<std::uint8_t> png;
		std::string source = "windowsGraphicsCapture";
		std::string source_detail;

		try
		{
			capture.Start(device, request.window, request.include_cursor);

			CapturedFrame frame;
			if (!capture.TryAcquire(device, geometry, frame, request.timeout_milliseconds)) {
				throw CaptureError(
					kStatusError,
					"capture_timeout",
					"That window produced no frame before the capture timeout. A window that is "
					"not redrawing produces no frames at all.");
			}

			layout = ComputeLayout(
				geometry,
				frame.surface_width,
				frame.surface_height,
				request.scale,
				request.maximum_dimension,
				/*even_dimensions=*/false);
			if (layout.content_width < 1 || layout.content_height < 1) {
				throw CaptureError(
					kStatusMinimized,
					"capture_no_content",
					"That window currently has no visible content to capture.");
			}

			const ComPtr<ID3D11Texture2D> cropped =
				CropFrame(device, frame, layout, /*cpu_readable=*/true);
			png = EncodePng(
				device,
				cropped.Get(),
				layout.content_width,
				layout.content_height,
				layout.capture_width,
				layout.capture_height);
			capture.Stop();
			capabilities = capture.Capabilities();
		} catch (const CaptureError& error) {
			// A machine without Windows.Graphics.Capture still gets a still frame, but never
			// silently: PrintWindow misses hardware overlays and composited content, so the
			// descriptor names the degraded source and says why it was used.
			if (error.Status() != kStatusUnavailable) {
				throw;
			}
			capture.Stop();
			layout = ComputeLayout(
				geometry,
				geometry.frame.right - geometry.frame.left,
				geometry.frame.bottom - geometry.frame.top,
				request.scale,
				request.maximum_dimension,
				/*even_dimensions=*/false);
			png = PrintWindowPng(request.window, geometry, layout);
			source = "printWindow";
			source_detail = std::string(error.what())
				+ " The image came from PrintWindow instead, which cannot see hardware overlays "
				"or composited content.";
		}

		capabilities.adapter = device.AdapterDescription();
		geometry_json = GeometryJson(geometry, layout);
		capabilities_json = CapabilitiesJson(capabilities);

		JsonObject root;
		root.Number("schemaVersion", 1);
		root.Boolean("ok", true);
		root.String("helperVersion", Utf8(MOBILE_CANVAS_HELPER_VERSION));
		root.String("type", "descriptor");
		root.String("status", kStatusOk);
		root.String("source", source);
		if (geometry.excluded_from_capture) {
			source_detail += source_detail.empty() ? "" : " ";
			source_detail +=
				"This window sets a display affinity that excludes it from capture, so the image "
				"may be blank.";
		}
		if (!source_detail.empty()) {
			root.String("sourceDetail", source_detail);
		}
		root.Signed(
			"handle",
			static_cast<std::int64_t>(reinterpret_cast<uintptr_t>(request.window)));
		root.Signed("processId", static_cast<std::int64_t>(WindowProcessId(request.window)));
		root.Signed(
			"processStartFileTime",
			static_cast<std::int64_t>(WindowProcessStartFileTime(request.window)));
		root.Signed("byteCount", static_cast<std::int64_t>(png.size()));
		root.Double("scale", layout.scale);
		root.Raw("geometry", geometry_json);
		root.Raw("capabilities", capabilities_json);

		_setmode(_fileno(stdout), _O_BINARY);
		if (!png.empty()) {
			std::fwrite(png.data(), 1, png.size(), stdout);
		}
		std::fflush(stdout);
		std::fputs(root.Finish().c_str(), stderr);
		std::fputc('\n', stderr);
		return 0;
	} catch (const CaptureError& error) {
		JsonObject detail;
		detail.String("code", error.Code());
		detail.String("message", error.what());
		if (error.HasHresult()) {
			detail.String("hresult", HresultHex(error.Hresult()));
		}
		std::fputs(
			StatusLine(
				"descriptor",
				error.Status().c_str(),
				false,
				window,
				geometry_json,
				capabilities_json,
				nullptr,
				"",
				detail.Finish())
				.c_str(),
			stderr);
		std::fputc('\n', stderr);
		return 1;
	}
}

int RunCapture(const std::string& request_json) {
	HWND window = nullptr;
	try {
		const CaptureRequest request = ParseRequest(request_json, /*streaming=*/true);
		window = request.window;
		return RunCaptureLoop(
			request.window,
			request.frames_per_second,
			request.scale,
			request.average_bitrate,
			request.include_cursor,
			request.timeout_milliseconds);
	} catch (const CaptureError& error) {
		JsonObject detail;
		detail.String("code", error.Code());
		detail.String("message", error.what());
		if (error.HasHresult()) {
			detail.String("hresult", HresultHex(error.Hresult()));
		}
		std::fputs(
			StatusLine(
				"descriptor",
				error.Status().c_str(),
				false,
				window,
				"",
				"",
				nullptr,
				"",
				detail.Finish())
				.c_str(),
			stderr);
		std::fputc('\n', stderr);
		return 1;
	}
}

} // namespace helper
