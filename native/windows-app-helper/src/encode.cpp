#include "capture_internal.h"
#include "support.h"
#include "version.h"

#include <windows.h>
#include <codecapi.h>
#include <icodecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>

#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace helper {
namespace {

constexpr std::int64_t kHundredNanosecondsPerSecond = 10000000;

/// How long the loop tolerates a silent window before it looks for a reason. A window that is not
/// redrawing produces no frames at all, which is normal, so this is a check interval rather than a
/// failure timeout.
constexpr int kIdleCheckMilliseconds = 250;

void Check(HRESULT result, const char* message) {
	if (FAILED(result)) {
		throw CaptureError(kStatusError, "capture_encoder_failed", message, result);
	}
}

/// Media Foundation, started for the lifetime of one capture.
class MediaFoundation final {
public:
	MediaFoundation() {
		const HRESULT result = MFStartup(MF_VERSION, MFSTARTUP_LITE);
		if (FAILED(result)) {
			throw CaptureError(
				kStatusUnavailable,
				"capture_media_foundation_unavailable",
				"Could not start Media Foundation, so no encoder is available.",
				result);
		}
		started_ = true;
	}

	~MediaFoundation() {
		if (started_) {
			MFShutdown();
		}
	}

	MediaFoundation(const MediaFoundation&) = delete;
	MediaFoundation& operator=(const MediaFoundation&) = delete;

private:
	bool started_ = false;
};

ComPtr<IMFMediaType> VideoType(
	const GUID& subtype,
	int width,
	int height,
	int frames_per_second) {
	ComPtr<IMFMediaType> type;
	Check(MFCreateMediaType(type.Put()), "Could not create a media type.");
	Check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "Could not set the media type.");
	Check(type->SetGUID(MF_MT_SUBTYPE, subtype), "Could not set the media subtype.");
	Check(
		type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive),
		"Could not set progressive scan.");
	Check(
		MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, static_cast<UINT32>(width), static_cast<UINT32>(height)),
		"Could not set the frame size.");
	if (frames_per_second > 0) {
		Check(
			MFSetAttributeRatio(
				type.Get(),
				MF_MT_FRAME_RATE,
				static_cast<UINT32>(frames_per_second),
				1),
			"Could not set the frame rate.");
	}
	Check(
		MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
		"Could not set the pixel aspect ratio.");
	return type;
}

ComPtr<IMFSample> WrapTexture(ID3D11Texture2D* texture, UINT subresource) {
	ComPtr<IMFMediaBuffer> buffer;
	Check(
		MFCreateDXGISurfaceBuffer(
			__uuidof(ID3D11Texture2D),
			texture,
			subresource,
			FALSE,
			buffer.Put()),
		"Could not wrap a Direct3D texture for Media Foundation.");

	ComPtr<IMF2DBuffer> two_dimensional;
	if (SUCCEEDED(buffer->QueryInterface(
			__uuidof(IMF2DBuffer),
			reinterpret_cast<void**>(two_dimensional.Put())))) {
		DWORD length = 0;
		if (SUCCEEDED(two_dimensional->GetContiguousLength(&length))) {
			buffer->SetCurrentLength(length);
		}
	}

	ComPtr<IMFSample> sample;
	Check(MFCreateSample(sample.Put()), "Could not create a media sample.");
	Check(sample->AddBuffer(buffer.Get()), "Could not attach a buffer to a media sample.");
	return sample;
}

/// Converts captured BGRA frames into NV12 at the encoded size.
///
/// The Video Processor MFT does the colour conversion and the scaling on the GPU when a Direct3D
/// manager is available, which keeps a full-resolution window off the CPU entirely.
class Nv12Converter final {
public:
	void Start(
		GraphicsDevice& device,
		IMFDXGIDeviceManager* manager,
		int source_width,
		int source_height,
		int target_width,
		int target_height,
		int frames_per_second) {
		device_ = &device;
		target_width_ = target_width;
		target_height_ = target_height;

		Check(
			CoCreateInstance(
				CLSID_VideoProcessorMFT,
				nullptr,
				CLSCTX_INPROC_SERVER,
				__uuidof(IMFTransform),
				reinterpret_cast<void**>(transform_.Put())),
			"Could not create the video processor.");

		ComPtr<IMFAttributes> attributes;
		Check(
			transform_->GetAttributes(attributes.Put()),
			"Could not read video processor attributes.");
		Check(
			attributes->SetUINT32(MF_XVP_DISABLE_FRC, TRUE),
			"Could not disable video processor frame-rate conversion.");
		Check(
			attributes->SetUINT32(MF_XVP_CALLER_ALLOCATES_OUTPUT, TRUE),
			"Could not select caller-owned video processor output.");
		attributes->SetUINT32(MF_LOW_LATENCY, TRUE);

		if (manager != nullptr) {
			Check(
				transform_->ProcessMessage(
					MFT_MESSAGE_SET_D3D_MANAGER,
					reinterpret_cast<ULONG_PTR>(manager)),
				"Could not connect the video processor to the Direct3D device.");
		}

		const ComPtr<IMFMediaType> input =
			VideoType(MFVideoFormat_ARGB32, source_width, source_height, 0);
		Check(
			transform_->SetInputType(0, input.Get(), 0),
			"The video processor refused the captured frame format.");
		const ComPtr<IMFMediaType> output =
			VideoType(MFVideoFormat_NV12, target_width, target_height, 0);
		Check(
			transform_->SetOutputType(0, output.Get(), 0),
			"The video processor refused the NV12 output format.");

		transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
		transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
	}

	std::vector<ComPtr<IMFSample>> Convert(
		ID3D11Texture2D* texture,
		std::int64_t time,
		std::int64_t duration) {
		std::vector<ComPtr<IMFSample>> outputs;
		ComPtr<IMFSample> input = WrapTexture(texture, 0);
		Check(input->SetSampleTime(time), "Could not timestamp a frame.");
		Check(input->SetSampleDuration(duration), "Could not set a frame duration.");
		HRESULT input_result = transform_->ProcessInput(0, input.Get(), 0);
		if (input_result == MF_E_NOTACCEPTING) {
			// The video processor still has converted frames waiting. Drain every one, then offer
			// this same input again: MF_E_NOTACCEPTING consumes nothing, and a change-driven window
			// may never produce a replacement for a frame dropped here.
			DrainOutputs(time - duration, duration, outputs);
			input_result = transform_->ProcessInput(0, input.Get(), 0);
		}
		Check(input_result, "The video processor refused a frame.");
		DrainOutputs(time, duration, outputs);
		return outputs;
	}

	void Recycle(ComPtr<IMFSample> sample) {
		if (sample && output_pool_.size() < 3) {
			output_pool_.push_back(std::move(sample));
		}
	}

private:
	void DrainOutputs(
		std::int64_t fallback_time,
		std::int64_t fallback_duration,
		std::vector<ComPtr<IMFSample>>& outputs) {
		for (int count = 0; count <= 16; ++count) {
			ComPtr<IMFSample> output = TakeOutput(fallback_time, fallback_duration);
			if (!output) {
				return;
			}
			if (count == 16) {
				throw CaptureError(
					kStatusError,
					"capture_converter_backlog",
					"The video processor produced more than 16 queued frames.");
			}
			outputs.push_back(std::move(output));
			fallback_time += fallback_duration;
		}
	}

	ComPtr<IMFSample> TakeOutput(std::int64_t fallback_time, std::int64_t fallback_duration) {
		MFT_OUTPUT_DATA_BUFFER output = {};
		ComPtr<IMFSample> allocated = AllocateOutput();
		output.pSample = allocated.Get();

		DWORD status = 0;
		const HRESULT result = transform_->ProcessOutput(0, 1, &output, &status);
		if (output.pEvents != nullptr) {
			output.pEvents->Release();
		}
		if (result == MF_E_TRANSFORM_NEED_MORE_INPUT) {
			Recycle(std::move(allocated));
			return {};
		}
		if (FAILED(result)) {
			if (output.pSample != nullptr && output.pSample != allocated.Get()) {
				output.pSample->Release();
			}
			Recycle(std::move(allocated));
		}
		Check(result, "The video processor produced no NV12 frame.");

		ComPtr<IMFSample> produced;
		if (output.pSample != nullptr && output.pSample != allocated.Get()) {
			produced.Attach(output.pSample);
			Recycle(std::move(allocated));
		} else if (allocated) {
			produced = std::move(allocated);
		}
		if (produced) {
			LONGLONG output_time = 0;
			if (FAILED(produced->GetSampleTime(&output_time))
				|| output_time <= last_output_time_) {
				const std::int64_t minimum = last_output_time_ < 0
					? 0
					: last_output_time_ + (std::max<std::int64_t>)(fallback_duration, 1);
				output_time = (std::max)(fallback_time, minimum);
				produced->SetSampleTime(output_time);
			}
			last_output_time_ = output_time;
			LONGLONG output_duration = 0;
			if (FAILED(produced->GetSampleDuration(&output_duration))) {
				produced->SetSampleDuration(fallback_duration);
			}
		}
		return produced;
	}

	int TargetWidth() const noexcept { return target_width_; }
	int TargetHeight() const noexcept { return target_height_; }

	ComPtr<IMFSample> AllocateOutput() {
		if (!output_pool_.empty()) {
			ComPtr<IMFSample> sample = std::move(output_pool_.back());
			output_pool_.pop_back();
			return sample;
		}
		D3D11_TEXTURE2D_DESC description = {};
		description.Width = static_cast<UINT>(target_width_);
		description.Height = static_cast<UINT>(target_height_);
		description.MipLevels = 1;
		description.ArraySize = 1;
		description.Format = DXGI_FORMAT_NV12;
		description.SampleDesc.Count = 1;
		description.Usage = D3D11_USAGE_DEFAULT;
		description.BindFlags = D3D11_BIND_RENDER_TARGET;

		ComPtr<ID3D11Texture2D> texture;
		Check(
			device_->Device()->CreateTexture2D(&description, nullptr, texture.Put()),
			"Could not allocate an NV12 frame.");
		return WrapTexture(texture.Get(), 0);
	}

	GraphicsDevice* device_ = nullptr;
	ComPtr<IMFTransform> transform_;
	std::vector<ComPtr<IMFSample>> output_pool_;
	int target_width_ = 0;
	int target_height_ = 0;
	std::int64_t last_output_time_ = -1;
};

/// Copies a GPU NV12 sample into system memory, for the software encoder fallback.
ComPtr<IMFSample> ToSystemMemory(
	GraphicsDevice& device,
	IMFSample* sample,
	int width,
	int height) {
	ComPtr<IMFMediaBuffer> buffer;
	Check(sample->GetBufferByIndex(0, buffer.Put()), "Could not read an encoded frame buffer.");

	ComPtr<IMFDXGIBuffer> dxgi;
	if (FAILED(buffer->QueryInterface(
			__uuidof(IMFDXGIBuffer),
			reinterpret_cast<void**>(dxgi.Put())))) {
		// Already system memory: the video processor ran without a Direct3D manager.
		ComPtr<IMFSample> passthrough;
		sample->AddRef();
		passthrough.Attach(sample);
		return passthrough;
	}

	ComPtr<ID3D11Texture2D> texture;
	Check(
		dxgi->GetResource(__uuidof(ID3D11Texture2D), reinterpret_cast<void**>(texture.Put())),
		"Could not read the NV12 texture.");
	UINT subresource = 0;
	dxgi->GetSubresourceIndex(&subresource);

	D3D11_TEXTURE2D_DESC description = {};
	texture->GetDesc(&description);
	description.Usage = D3D11_USAGE_STAGING;
	description.BindFlags = 0;
	description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
	description.MiscFlags = 0;
	description.ArraySize = 1;
	description.MipLevels = 1;

	ComPtr<ID3D11Texture2D> staging;
	Check(
		device.Device()->CreateTexture2D(&description, nullptr, staging.Put()),
		"Could not allocate a readable NV12 frame.");
	device.Context()->CopySubresourceRegion(
		staging.Get(),
		0,
		0,
		0,
		0,
		texture.Get(),
		subresource,
		nullptr);

	D3D11_MAPPED_SUBRESOURCE mapped = {};
	Check(
		device.Context()->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped),
		"Could not read an NV12 frame.");

	const size_t luma = static_cast<size_t>(width) * static_cast<size_t>(height);
	const size_t total = luma + (luma / 2);
	ComPtr<IMFMediaBuffer> copy;
	const HRESULT created = MFCreateMemoryBuffer(static_cast<DWORD>(total), copy.Put());
	if (FAILED(created)) {
		device.Context()->Unmap(staging.Get(), 0);
		Check(created, "Could not allocate a system-memory frame.");
	}

	BYTE* destination = nullptr;
	const HRESULT locked = copy->Lock(&destination, nullptr, nullptr);
	if (FAILED(locked)) {
		device.Context()->Unmap(staging.Get(), 0);
		Check(locked, "Could not write a system-memory frame.");
	}

	const auto* source = static_cast<const std::uint8_t*>(mapped.pData);
	for (int row = 0; row < height; ++row) {
		std::memcpy(
			destination + (static_cast<size_t>(row) * static_cast<size_t>(width)),
			source + (static_cast<size_t>(row) * mapped.RowPitch),
			static_cast<size_t>(width));
	}
	const auto* chroma = source + (static_cast<size_t>(description.Height) * mapped.RowPitch);
	for (int row = 0; row < height / 2; ++row) {
		std::memcpy(
			destination + luma + (static_cast<size_t>(row) * static_cast<size_t>(width)),
			chroma + (static_cast<size_t>(row) * mapped.RowPitch),
			static_cast<size_t>(width));
	}

	copy->Unlock();
	copy->SetCurrentLength(static_cast<DWORD>(total));
	device.Context()->Unmap(staging.Get(), 0);

	ComPtr<IMFSample> result;
	Check(MFCreateSample(result.Put()), "Could not create a system-memory sample.");
	Check(result->AddBuffer(copy.Get()), "Could not attach a system-memory buffer.");

	LONGLONG time = 0;
	LONGLONG duration = 0;
	if (SUCCEEDED(sample->GetSampleTime(&time))) {
		result->SetSampleTime(time);
	}
	if (SUCCEEDED(sample->GetSampleDuration(&duration))) {
		result->SetSampleDuration(duration);
	}
	return result;
}

/// Enumerates H.264 encoders, preferring a hardware transform on the same adapter frames were
/// captured on. A cross-adapter hardware encoder would need a copy through system memory on every
/// frame, which is worse than the software encoder it would be trying to beat.
std::vector<ComPtr<IMFActivate>> EnumerateEncoders(const LUID& adapter, bool hardware) {
	MFT_REGISTER_TYPE_INFO output = { MFMediaType_Video, MFVideoFormat_H264 };
	MFT_REGISTER_TYPE_INFO input = { MFMediaType_Video, MFVideoFormat_NV12 };
	const UINT32 flags = hardware
		? (MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER)
		: (MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_LOCALMFT
			| MFT_ENUM_FLAG_SORTANDFILTER);

	IMFActivate** activations = nullptr;
	UINT32 count = 0;
	HRESULT result = E_FAIL;

	using MFTEnum2Signature = HRESULT(WINAPI*)(
		GUID,
		UINT32,
		const MFT_REGISTER_TYPE_INFO*,
		const MFT_REGISTER_TYPE_INFO*,
		IMFAttributes*,
		IMFActivate***,
		UINT32*);
	// MFTEnum2 arrived in Windows 10 and is the only way to ask for one adapter's encoders. It is
	// resolved dynamically so the helper still loads, and still reports capabilities, on a build
	// that does not have it.
	if (hardware) {
		if (HMODULE mfplat = GetModuleHandleW(L"mfplat.dll")) {
			if (auto enumerate =
					reinterpret_cast<MFTEnum2Signature>(GetProcAddress(mfplat, "MFTEnum2"))) {
				ComPtr<IMFAttributes> attributes;
				if (SUCCEEDED(MFCreateAttributes(attributes.Put(), 1))) {
					attributes->SetBlob(
						MFT_ENUM_ADAPTER_LUID,
						reinterpret_cast<const UINT8*>(&adapter),
						sizeof(adapter));
					result = enumerate(
						MFT_CATEGORY_VIDEO_ENCODER,
						flags,
						&input,
						&output,
						attributes.Get(),
						&activations,
						&count);
				}
			}
		}
	}

	if (FAILED(result) || count == 0) {
		if (activations != nullptr) {
			CoTaskMemFree(activations);
			activations = nullptr;
			count = 0;
		}
		result = MFTEnumEx(
			MFT_CATEGORY_VIDEO_ENCODER,
			flags,
			&input,
			&output,
			&activations,
			&count);
	}

	std::vector<ComPtr<IMFActivate>> found;
	if (SUCCEEDED(result)) {
		for (UINT32 index = 0; index < count; ++index) {
			ComPtr<IMFActivate> activation;
			activation.Attach(activations[index]);
			found.push_back(std::move(activation));
		}
	}
	CoTaskMemFree(activations);
	return found;
}

std::wstring FriendlyName(IMFActivate* activation) {
	UINT32 length = 0;
	std::vector<wchar_t> buffer(256, L'\0');
	if (SUCCEEDED(activation->GetString(
			MFT_FRIENDLY_NAME_Attribute,
			buffer.data(),
			static_cast<UINT32>(buffer.size()),
			&length))) {
		return std::wstring(buffer.data(), length);
	}
	return L"";
}

/// The low-delay H.264 encoder.
///
/// B-frames are switched off and the group of pictures is one second long: a stream that a browser
/// reconnects to has to show a picture immediately, and a reordered frame would add exactly the
/// latency this path exists to avoid.
class H264Encoder final {
public:
	void Start(
		GraphicsDevice& device,
		IMFDXGIDeviceManager* manager,
		int width,
		int height,
		int frames_per_second,
		std::int64_t average_bitrate,
		CaptureCapabilities& capabilities) {
		device_ = &device;
		width_ = width;
		height_ = height;

		// This implementation drains transforms synchronously and recycles each caller-owned NV12
		// surface after Submit returns. Hardware MFTs require an asynchronous event pump before that
		// lifetime is safe, so the production synchronous path deliberately selects software only.
		for (const bool hardware : { false }) {
			for (const auto& activation : EnumerateEncoders(device.Adapter(), hardware)) {
				ComPtr<IMFTransform> transform;
				if (FAILED(activation->ActivateObject(
						__uuidof(IMFTransform),
						reinterpret_cast<void**>(transform.Put())))) {
					continue;
				}
				if (!Configure(
						transform,
						hardware ? manager : nullptr,
						width,
						height,
						frames_per_second,
						average_bitrate)) {
					activation->ShutdownObject();
					continue;
				}
				transform_ = std::move(transform);
				hardware_ = hardware;
				capabilities.hardware_encoder = hardware;
				capabilities.encoder = FriendlyName(activation.Get());
				return;
			}
		}

		throw CaptureError(
			kStatusUnavailable,
			"capture_encoder_unavailable",
			"This machine has no usable H.264 encoder, so live video cannot be produced. A "
			"screenshot still can.");
	}

	bool Hardware() const noexcept { return hardware_; }

	/// Feeds one NV12 sample and writes whatever Annex-B bytes come back.
	void Submit(IMFSample* sample) {
		ComPtr<IMFSample> ready;
		if (!hardware_) {
			ready = ToSystemMemory(*device_, sample, width_, height_);
			sample = ready.Get();
		}

		const HRESULT result = transform_->ProcessInput(0, sample, 0);
		if (result == MF_E_NOTACCEPTING) {
			// The encoder still owes output. Draining first is the documented way to make
			// room, and it is also what keeps the queue bounded to a single frame.
			DrainOutputs(false);
			Check(transform_->ProcessInput(0, sample, 0), "The encoder refused a frame.");
		} else {
			Check(result, "The encoder refused a frame.");
		}
		DrainOutputs(false);
	}

	void Drain() {
		if (!transform_) {
			return;
		}
		transform_->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
		DrainOutputs(true);
	}

private:
	bool Configure(
		const ComPtr<IMFTransform>& transform,
		IMFDXGIDeviceManager* manager,
		int width,
		int height,
		int frames_per_second,
		std::int64_t average_bitrate) {
		ComPtr<IMFAttributes> attributes;
		if (SUCCEEDED(transform->GetAttributes(attributes.Put())) && attributes) {
			UINT32 value = 0;
			if (SUCCEEDED(attributes->GetUINT32(MF_TRANSFORM_ASYNC, &value)) && value != 0) {
				// Async hardware MFTs need an independent event/output pump. The capture loop is
				// intentionally synchronous and bounded, so select the software MFT rather than
				// accepting a hardware encoder that can stall a static window before its first frame.
				return false;
			}
			attributes->SetUINT32(MF_LOW_LATENCY, TRUE);
		}

		if (manager != nullptr &&
			FAILED(transform->ProcessMessage(
				MFT_MESSAGE_SET_D3D_MANAGER,
				reinterpret_cast<ULONG_PTR>(manager)))) {
			return false;
		}

		ComPtr<IMFMediaType> output =
			VideoType(MFVideoFormat_H264, width, height, frames_per_second);
		if (FAILED(output->SetUINT32(
				MF_MT_AVG_BITRATE,
				static_cast<UINT32>(std::clamp<std::int64_t>(
					average_bitrate,
					kMinimumBitrate,
					kMaximumBitrate))))
			|| FAILED(output->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main))
			|| FAILED(transform->SetOutputType(0, output.Get(), 0))) {
			return false;
		}

		const ComPtr<IMFMediaType> input =
			VideoType(MFVideoFormat_NV12, width, height, frames_per_second);
		const std::uint64_t sample_size =
			static_cast<std::uint64_t>(width) * static_cast<std::uint64_t>(height) * 3 / 2;
		if (sample_size > (std::numeric_limits<UINT32>::max)()) {
			return false;
		}
		input->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE);
		input->SetUINT32(MF_MT_SAMPLE_SIZE, static_cast<UINT32>(sample_size));
		input->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(width));
		if (FAILED(transform->SetInputType(0, input.Get(), 0))) {
			return false;
		}

		ComPtr<ICodecAPI> codec;
		if (SUCCEEDED(transform->QueryInterface(
				__uuidof(ICodecAPI),
				reinterpret_cast<void**>(codec.Put())))) {
			SetCodecValue(codec, CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR);
			SetCodecValue(
				codec,
				CODECAPI_AVEncCommonMeanBitRate,
				static_cast<ULONG>(std::clamp<std::int64_t>(
					average_bitrate,
					kMinimumBitrate,
					kMaximumBitrate)));
			// One keyframe per second keeps reconnect and packet-loss recovery short without
			// spending the bandwidth a per-frame keyframe would.
			SetCodecValue(codec, CODECAPI_AVEncMPVGOPSize, static_cast<ULONG>(frames_per_second));
			SetCodecValue(codec, CODECAPI_AVEncMPVDefaultBPictureCount, 0UL);
			SetCodecBoolean(codec, CODECAPI_AVLowLatencyMode, true);
			SetCodecBoolean(codec, CODECAPI_AVEncCommonRealTime, true);
		}

		ComPtr<IMFMediaType> current;
		if (SUCCEEDED(transform->GetOutputCurrentType(0, current.Put())) && current) {
			UINT32 size = 0;
			if (SUCCEEDED(current->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &size)) && size > 0) {
				sequence_header_.resize(size);
				if (FAILED(current->GetBlob(
						MF_MT_MPEG_SEQUENCE_HEADER,
						sequence_header_.data(),
						size,
						&size))) {
					sequence_header_.clear();
				}
			}
		}

		transform->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
		transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
		transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
		return true;
	}

	static void SetCodecValue(const ComPtr<ICodecAPI>& codec, const GUID& property, ULONG value) {
		VARIANT variant = {};
		variant.vt = VT_UI4;
		variant.ulVal = value;
		codec->SetValue(&property, &variant);
	}

	static void SetCodecBoolean(const ComPtr<ICodecAPI>& codec, const GUID& property, bool value) {
		VARIANT variant = {};
		variant.vt = VT_BOOL;
		variant.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
		codec->SetValue(&property, &variant);
	}

	void DrainOutputs(bool until_empty) {
		for (;;) {
			MFT_OUTPUT_STREAM_INFO info = {};
			transform_->GetOutputStreamInfo(0, &info);
			const bool provides = (info.dwFlags
				& (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;

			MFT_OUTPUT_DATA_BUFFER buffer = {};
			ComPtr<IMFSample> allocated;
			if (!provides) {
				ComPtr<IMFMediaBuffer> memory;
				Check(
					MFCreateMemoryBuffer(
						(std::max)(info.cbSize, static_cast<DWORD>(width_ * height_)),
						memory.Put()),
					"Could not allocate an encoded frame buffer.");
				Check(MFCreateSample(allocated.Put()), "Could not allocate an encoded frame.");
				Check(allocated->AddBuffer(memory.Get()), "Could not allocate an encoded frame.");
				buffer.pSample = allocated.Get();
			}

			DWORD status = 0;
			const HRESULT result = transform_->ProcessOutput(0, 1, &buffer, &status);
			ComPtr<IMFSample> produced;
			if (buffer.pSample != nullptr && buffer.pSample != allocated.Get()) {
				produced.Attach(buffer.pSample);
			} else if (allocated) {
				produced = std::move(allocated);
			}
			if (buffer.pEvents != nullptr) {
				buffer.pEvents->Release();
			}

			if (result == MF_E_TRANSFORM_NEED_MORE_INPUT) {
				return;
			}
			if (result == MF_E_TRANSFORM_STREAM_CHANGE) {
				// A stream change means the encoder wants a renegotiated output type. This stream
				// is about to end anyway, so it is reported rather than silently reconfigured.
				throw CaptureError(
					kStatusError,
					"capture_encoder_stream_changed",
					"The encoder renegotiated its output format mid-stream.");
			}
			Check(result, "The encoder produced no output.");
			if (produced) {
				Write(produced.Get());
			}
			if (!until_empty) {
				return;
			}
		}
	}

	void WriteOutput() {
		MFT_OUTPUT_STREAM_INFO info = {};
		transform_->GetOutputStreamInfo(0, &info);
		const bool provides = (info.dwFlags
			& (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;

		MFT_OUTPUT_DATA_BUFFER buffer = {};
		ComPtr<IMFSample> allocated;
		if (!provides) {
			ComPtr<IMFMediaBuffer> memory;
			Check(
				MFCreateMemoryBuffer(
					(std::max)(info.cbSize, static_cast<DWORD>(width_ * height_)),
					memory.Put()),
				"Could not allocate an encoded frame buffer.");
			Check(MFCreateSample(allocated.Put()), "Could not allocate an encoded frame.");
			Check(allocated->AddBuffer(memory.Get()), "Could not allocate an encoded frame.");
			buffer.pSample = allocated.Get();
		}

		DWORD status = 0;
		const HRESULT result = transform_->ProcessOutput(0, 1, &buffer, &status);
		ComPtr<IMFSample> produced;
		if (buffer.pSample != nullptr && buffer.pSample != allocated.Get()) {
			produced.Attach(buffer.pSample);
		} else if (allocated) {
			produced = std::move(allocated);
		}
		if (buffer.pEvents != nullptr) {
			buffer.pEvents->Release();
		}
		if (FAILED(result)) {
			return;
		}
		if (produced) {
			Write(produced.Get());
		}
	}

	void Write(IMFSample* sample) {
		ComPtr<IMFMediaBuffer> buffer;
		Check(
			sample->ConvertToContiguousBuffer(buffer.Put()),
			"Could not read an encoded frame.");

		BYTE* data = nullptr;
		DWORD length = 0;
		Check(buffer->Lock(&data, nullptr, &length), "Could not read an encoded frame.");
		if (length > 0) {
			// The Microsoft and vendor encoders emit an Annex-B byte stream. The sequence header
			// is written once, and only when the first frame did not already carry it, so a
			// decoder never sees a picture before its parameter sets.
			if (!wrote_header_) {
				wrote_header_ = true;
				if (!sequence_header_.empty() && !StartsWithParameterSet(data, length)) {
					std::fwrite(sequence_header_.data(), 1, sequence_header_.size(), stdout);
				}
			}
			std::fwrite(data, 1, length, stdout);
			std::fflush(stdout);
		}
		buffer->Unlock();
	}

	static bool StartsWithParameterSet(const BYTE* data, DWORD length) {
		if (length >= 5 && data[0] == 0 && data[1] == 0 && data[2] == 0 && data[3] == 1) {
			return (data[4] & 0x1F) == 7;
		}
		if (length >= 4 && data[0] == 0 && data[1] == 0 && data[2] == 1) {
			return (data[3] & 0x1F) == 7;
		}
		return false;
	}

	GraphicsDevice* device_ = nullptr;
	ComPtr<IMFTransform> transform_;
	std::vector<UINT8> sequence_header_;
	bool hardware_ = false;
	bool wrote_header_ = false;
	int width_ = 0;
	int height_ = 0;
};

void WriteLine(const std::string& text) {
	std::fputs(text.c_str(), stderr);
	std::fputc('\n', stderr);
	std::fflush(stderr);
}

std::string EndLine(HWND window, const char* reason, const std::string& detail) {
	JsonObject root;
	root.Number("schemaVersion", 1);
	root.Boolean("ok", true);
	root.String("helperVersion", Utf8(MOBILE_CANVAS_HELPER_VERSION));
	root.String("type", "end");
	root.String("status", kStatusOk);
	root.String("source", "windowsGraphicsCapture");
	root.String("reason", reason);
	if (!detail.empty()) {
		root.String("sourceDetail", detail);
	}
	root.Signed("handle", static_cast<std::int64_t>(reinterpret_cast<uintptr_t>(window)));
	return root.Finish();
}

bool GeometryChanged(const WindowGeometry& first, const WindowGeometry& current) {
	return (first.content.right - first.content.left)
			!= (current.content.right - current.content.left)
		|| (first.content.bottom - first.content.top)
			!= (current.content.bottom - current.content.top);
}

} // namespace

int RunCaptureLoop(
	HWND window,
	int frames_per_second,
	double scale,
	std::int64_t average_bitrate,
	bool include_cursor,
	int startup_timeout_milliseconds) {
	Apartment apartment;

	// The window is checked before Media Foundation is started. A closed or minimized window has
	// nothing to stream, and spinning up an encoder stack only to report that would turn a clear
	// answer into a slower and less honest one on a machine without a working encoder.
	WindowGeometry geometry = ReadWindowGeometry(window);
	if (!geometry.window_exists) {
		throw CaptureError(kStatusClosed, "capture_window_closed", "That window no longer exists.");
	}
	if (geometry.minimized) {
		throw CaptureError(
			kStatusMinimized,
			"capture_minimized",
			"That window is minimized, so it has no visible content to stream.");
	}

	MediaFoundation media_foundation;

	GraphicsDevice device;
	device.Start();

	WindowCapture capture;
	capture.Start(device, window, include_cursor);

	CapturedFrame frame;
	if (!capture.TryAcquire(device, geometry, frame, startup_timeout_milliseconds)) {
		throw CaptureError(
			kStatusError,
			"capture_timeout",
			"That window produced no frame before the capture timeout.");
	}

	const CaptureLayout layout = ComputeLayout(
		geometry,
		frame.surface_width,
		frame.surface_height,
		scale,
		0,
		/*even_dimensions=*/true);
	if (layout.content_width < kMinimumCaptureDimension
		|| layout.content_height < kMinimumCaptureDimension) {
		throw CaptureError(
			kStatusError,
			"capture_too_small",
			"That window is smaller than the minimum encodable size.");
	}

	ComPtr<IMFDXGIDeviceManager> manager;
	UINT token = 0;
	if (SUCCEEDED(MFCreateDXGIDeviceManager(&token, manager.Put()))) {
		manager->ResetDevice(device.Device(), token);
	}

	CaptureCapabilities capabilities = capture.Capabilities();
	capabilities.adapter = device.AdapterDescription();

	Nv12Converter converter;
	converter.Start(
		device,
		manager.Get(),
		layout.content_width,
		layout.content_height,
		layout.capture_width,
		layout.capture_height,
		frames_per_second);

	H264Encoder encoder;
	encoder.Start(
		device,
		manager.Get(),
		layout.capture_width,
		layout.capture_height,
		frames_per_second,
		average_bitrate,
		capabilities);

	JsonObject descriptor;
	descriptor.Number("schemaVersion", 1);
	descriptor.Boolean("ok", true);
	descriptor.String("helperVersion", Utf8(MOBILE_CANVAS_HELPER_VERSION));
	descriptor.String("type", "descriptor");
	descriptor.String("status", kStatusOk);
	descriptor.String("source", "windowsGraphicsCapture");
	if (geometry.excluded_from_capture) {
		descriptor.String(
			"sourceDetail",
			"This window sets a display affinity that excludes it from capture, so the stream may "
			"be blank.");
	}
	descriptor.Signed("handle", static_cast<std::int64_t>(reinterpret_cast<uintptr_t>(window)));
	descriptor.Signed("processId", static_cast<std::int64_t>(WindowProcessId(window)));
	descriptor.Signed(
		"processStartFileTime",
		static_cast<std::int64_t>(WindowProcessStartFileTime(window)));
	descriptor.Signed("framesPerSecond", frames_per_second);
	descriptor.Double("scale", layout.scale);
	descriptor.Signed("averageBitrate", average_bitrate);
	descriptor.Raw("geometry", GeometryJson(geometry, layout));
	descriptor.Raw("capabilities", CapabilitiesJson(capabilities));

	_setmode(_fileno(stdout), _O_BINARY);
	WriteLine(descriptor.Finish());

	const std::int64_t duration = kHundredNanosecondsPerSecond / frames_per_second;
	const auto interval = std::chrono::microseconds(1000000 / frames_per_second);
	std::int64_t origin = frame.system_relative_time;
	std::int64_t emitted = 0;
	const char* reason = kEndClientClosed;
	std::string detail;

	try {
		// The frame that established the encoder geometry is also the only frame a static window
		// may ever produce. Encode it before waiting for a change, then return its pooled WGC surface.
		const ComPtr<ID3D11Texture2D> initial =
			CropFrame(device, frame, layout, /*cpu_readable=*/false);
		for (auto& nv12 : converter.Convert(initial.Get(), 0, duration)) {
			encoder.Submit(nv12.Get());
			++emitted;
			converter.Recycle(std::move(nv12));
		}
		frame.Close();

		auto next = std::chrono::steady_clock::now();
		for (;;) {
			const WindowGeometry current = ReadWindowGeometry(window);
			if (!current.window_exists) {
				reason = kEndWindowClosed;
				break;
			}
			if (current.minimized) {
				reason = kEndMinimized;
				detail = "The window was minimized, so it stopped producing frames.";
				break;
			}
			if (current.dpi != geometry.dpi) {
				reason = kEndDpiChanged;
				detail = "The window moved to a display with a different scale factor.";
				break;
			}
			if (GeometryChanged(geometry, current)) {
				reason = kEndContentSizeChanged;
				detail = "The window was resized, so the encoder was ended rather than fed frames "
					"of a size it was not configured for.";
				break;
			}

			CapturedFrame next_frame;
			if (capture.TryAcquire(device, current, next_frame, kIdleCheckMilliseconds)) {
				if (next_frame.surface_width != frame.surface_width
					|| next_frame.surface_height != frame.surface_height) {
					reason = kEndContentSizeChanged;
					detail = "The window's capture surface changed size.";
					break;
				}

				const ComPtr<ID3D11Texture2D> cropped =
					CropFrame(device, next_frame, layout, /*cpu_readable=*/false);
				const std::int64_t time =
					(std::max)(next_frame.system_relative_time - origin, emitted * duration);
				for (auto& nv12 : converter.Convert(cropped.Get(), time, duration)) {
					encoder.Submit(nv12.Get());
					++emitted;
					converter.Recycle(std::move(nv12));
				}
			}

			if (std::ferror(stdout) != 0) {
				reason = kEndClientClosed;
				break;
			}

			next += interval;
			const auto now = std::chrono::steady_clock::now();
			if (next > now) {
				std::this_thread::sleep_for(next - now);
			} else {
				next = now;
			}
		}
	} catch (const CaptureError& error) {
		reason = kEndEncoderFailed;
		detail = error.what();
		if (error.HasHresult()) {
			detail += " (" + HresultHex(error.Hresult()) + ")";
		}
	}

	try {
		encoder.Drain();
	} catch (const CaptureError&) {
		// The stream is already ending; a failure while draining changes nothing the caller can
		// act on beyond the reason that is about to be reported.
	}
	capture.Stop();
	std::fflush(stdout);
	WriteLine(EndLine(window, reason, detail));
	return 0;
}

} // namespace helper
