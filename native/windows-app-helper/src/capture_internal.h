#pragma once

#include "support.h"

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>

#include <windows.graphics.capture.h>
#include <windows.graphics.directx.direct3d11.h>

#include <cstdint>
#include <string>

namespace helper {

/// Hard bounds, mirrored from WindowsCaptureLimits on the managed side. Both ends refuse the same
/// values so a request that survives one layer cannot surprise the other.
constexpr int kMinimumCaptureDimension = 16;
constexpr int kMaximumCaptureDimension = 16384;
constexpr int kMinimumFramesPerSecond = 1;
constexpr int kMaximumFramesPerSecond = 60;
constexpr std::int64_t kMinimumBitrate = 200000;
constexpr std::int64_t kMaximumBitrate = 40000000;
constexpr int kMaximumStartupTimeoutMilliseconds = 30000;
constexpr int kDefaultFrameTimeoutMilliseconds = 5000;
constexpr std::size_t kMaximumCaptureRequestBytes = 8 * 1024;

/// Machine-readable capture statuses, matching WindowsCaptureStatuses.
constexpr char kStatusOk[] = "ok";
constexpr char kStatusMinimized[] = "minimized";
constexpr char kStatusProtected[] = "protected";
constexpr char kStatusClosed[] = "closed";
constexpr char kStatusUnavailable[] = "unavailable";
constexpr char kStatusError[] = "error";

/// Reasons a live stream stopped, matching WindowsStreamEndReasons.
constexpr char kEndContentSizeChanged[] = "contentSizeChanged";
constexpr char kEndDpiChanged[] = "dpiChanged";
constexpr char kEndMinimized[] = "minimized";
constexpr char kEndWindowClosed[] = "windowClosed";
constexpr char kEndCaptureFailed[] = "captureFailed";
constexpr char kEndEncoderFailed[] = "encoderFailed";
constexpr char kEndClientClosed[] = "clientClosed";

/// A capture failure that already knows which status the host should report.
class CaptureError final : public std::runtime_error {
public:
	CaptureError(std::string status, std::string code, std::string message)
		: std::runtime_error(message),
		  status_(std::move(status)),
		  code_(std::move(code)) {}

	CaptureError(std::string status, std::string code, std::string message, HRESULT hresult)
		: std::runtime_error(message),
		  status_(std::move(status)),
		  code_(std::move(code)),
		  hresult_(hresult),
		  has_hresult_(true) {}

	const std::string& Status() const noexcept { return status_; }
	const std::string& Code() const noexcept { return code_; }
	bool HasHresult() const noexcept { return has_hresult_; }
	HRESULT Hresult() const noexcept { return hresult_; }

private:
	std::string status_;
	std::string code_;
	HRESULT hresult_ = S_OK;
	bool has_hresult_ = false;
};

/// One window's geometry, read exactly the way the managed host reads it so the transform token
/// both sides derive from these numbers agrees.
struct WindowGeometry {
	RECT frame = {};
	RECT content = {};
	RECT client = {};
	std::uint32_t dpi = 96;
	bool minimized = false;
	bool window_exists = false;
	bool excluded_from_capture = false;
};

WindowGeometry ReadWindowGeometry(HWND window);

/// Which optional Windows.Graphics.Capture behaviours this machine actually offers. Every one of
/// them arrived after picker-free capture itself, so none is required.
struct CaptureCapabilities {
	bool free_threaded_frame_pool = false;
	bool cursor_capture_toggle = false;
	bool border_required_toggle = false;
	bool secondary_window_capture = false;
	bool dirty_region_mode = false;
	bool cursor_captured = false;
	bool border_required = true;
	bool hardware_encoder = false;
	std::wstring encoder;
	std::wstring adapter;
};

/// The Direct3D device frames are captured and converted on.
class GraphicsDevice final {
public:
	void Start();

	ID3D11Device* Device() const noexcept { return device_.Get(); }
	ID3D11DeviceContext* Context() const noexcept { return context_.Get(); }
	ABI::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice* Runtime() const noexcept {
		return runtime_.Get();
	}
	const LUID& Adapter() const noexcept { return adapter_; }
	const std::wstring& AdapterDescription() const noexcept { return adapter_description_; }

private:
	ComPtr<ID3D11Device> device_;
	ComPtr<ID3D11DeviceContext> context_;
	ComPtr<ABI::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice> runtime_;
	LUID adapter_ = {};
	std::wstring adapter_description_;
};

/// One captured frame, already cropped to the window's visible content.
struct CapturedFrame {
	CapturedFrame() = default;
	~CapturedFrame();

	CapturedFrame(const CapturedFrame&) = delete;
	CapturedFrame& operator=(const CapturedFrame&) = delete;
	CapturedFrame(CapturedFrame&&) = delete;
	CapturedFrame& operator=(CapturedFrame&&) = delete;

	/// Keeps the WGC frame checked out until every GPU copy using its pooled surface is queued.
	/// Releasing the texture alone is insufficient: closing the frame returns that surface to the
	/// frame pool, which may overwrite it on the capture thread.
	void Close() noexcept;

	ComPtr<ABI::Windows::Graphics::Capture::IDirect3D11CaptureFrame> source_frame;
	ComPtr<ID3D11Texture2D> texture;
	int width = 0;
	int height = 0;
	int surface_width = 0;
	int surface_height = 0;
	int offset_x = 0;
	int offset_y = 0;
	std::int64_t system_relative_time = 0;
};

/// A picker-free Windows.Graphics.Capture session on one window handle.
///
/// The handle arrives only from the guarded managed bridge, which resolved an opaque, panel-scoped
/// capability first; nothing here treats a handle as authorization. Frames are polled and drained
/// rather than delivered through an event, so the newest frame is always the one encoded and stale
/// frames are released immediately instead of queueing behind a slow encoder.
class WindowCapture final {
public:
	~WindowCapture();

	void Start(GraphicsDevice& device, HWND window, bool include_cursor);
	void Stop();

	/// The newest frame available, cropped to the visible content, or false on timeout.
	bool TryAcquire(
		GraphicsDevice& device,
		const WindowGeometry& geometry,
		CapturedFrame& frame,
		int timeout_milliseconds);

	const CaptureCapabilities& Capabilities() const noexcept { return capabilities_; }
	int ItemWidth() const noexcept { return item_width_; }
	int ItemHeight() const noexcept { return item_height_; }

private:
	ComPtr<ABI::Windows::Graphics::Capture::IGraphicsCaptureItem> item_;
	ComPtr<ABI::Windows::Graphics::Capture::IDirect3D11CaptureFramePool> pool_;
	ComPtr<ABI::Windows::Graphics::Capture::IGraphicsCaptureSession> session_;
	CaptureCapabilities capabilities_;
	int item_width_ = 0;
	int item_height_ = 0;
	bool started_ = false;
};

/// Where the visible content sits inside a captured surface, and how large the delivered image is.
struct CaptureLayout {
	int offset_x = 0;
	int offset_y = 0;
	int surface_width = 0;
	int surface_height = 0;
	int content_width = 0;
	int content_height = 0;
	int capture_width = 0;
	int capture_height = 0;
	double scale = 1;
};

CaptureLayout ComputeLayout(
	const WindowGeometry& geometry,
	int surface_width,
	int surface_height,
	double scale,
	int maximum_dimension,
	bool even_dimensions);

std::string GeometryJson(const WindowGeometry& geometry, const CaptureLayout& layout);
std::string CapabilitiesJson(const CaptureCapabilities& capabilities);

/// Copies the visible crop of a captured frame into a fresh BGRA texture on the GPU.
ComPtr<ID3D11Texture2D> CropFrame(
	GraphicsDevice& device,
	const CapturedFrame& frame,
	const CaptureLayout& layout,
	bool cpu_readable);

/// Encodes a CPU-readable BGRA texture as PNG through the Windows Imaging Component.
std::vector<std::uint8_t> EncodePng(
	GraphicsDevice& device,
	ID3D11Texture2D* texture,
	int source_width,
	int source_height,
	int target_width,
	int target_height);

/// Encodes raw top-down BGRA pixels as PNG, scaling when the target size differs.
std::vector<std::uint8_t> EncodePngPixels(
	const std::uint8_t* pixels,
	int source_width,
	int source_height,
	std::size_t stride,
	int target_width,
	int target_height);

/// The explicitly degraded still-capture path, used only when Windows.Graphics.Capture is
/// unavailable on the machine and always reported as such.
std::vector<std::uint8_t> PrintWindowPng(
	HWND window,
	const WindowGeometry& geometry,
	const CaptureLayout& layout);

/// The long-lived Media Foundation encode loop. Declared here so the capture command stays in one
/// translation unit while the Media Foundation work lives in its own.
int RunCaptureLoop(
	HWND window,
	int frames_per_second,
	double scale,
	std::int64_t average_bitrate,
	bool include_cursor,
	int startup_timeout_milliseconds);

} // namespace helper
