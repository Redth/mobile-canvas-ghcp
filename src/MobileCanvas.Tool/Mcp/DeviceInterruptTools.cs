using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

/// <summary>
/// The events that arrive from outside an app and interrupt it -- a notification, a call, a text, a
/// biometric prompt -- which are the states apps handle worst and are hardest to reach by hand.
/// </summary>
[McpServerToolType]
public sealed class DeviceInterruptTools(DeviceHostClient client)
{
	[McpServerTool(Name = "mobile_device_notification_push", Title = "Send a push notification", OpenWorld = false)]
	[Description(
		"Deliver a simulated remote push notification to an installed app, so notification handling "
		+ "can be exercised without a server or a signing certificate. iOS only: the Android emulator "
		+ "has no equivalent, and reaching an Android app this way means sending it a real FCM "
		+ "message. The payload is APNs JSON and must contain an 'aps' key, for example "
		+ """{"aps":{"alert":{"title":"Hello","body":"World"}}}. """
		+ "The app must already have been granted notification permission, which only happens when "
		+ "the app itself asks; this reports that rather than reporting a delivery iOS silently "
		+ "dropped.")]
	public Task<OperationResult> Push(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("The bundle ID of the app to notify. It must already be installed.")] string bundleId,
		[Description("The APNs payload as JSON, 4096 bytes or less, containing an 'aps' key.")] string payload,
		CancellationToken cancellationToken = default) =>
		client.SendPushNotificationAsync(
			deviceId,
			new PushNotificationRequest { BundleId = bundleId, Payload = payload },
			cancellationToken);

	[McpServerTool(Name = "mobile_device_sms_send", Title = "Deliver a text message", OpenWorld = false)]
	[Description(
		"Deliver an inbound text message, as though it arrived over the network. Android only: an iOS "
		+ "simulator has no messaging stack. Useful for one-time-code flows and for interrupting the "
		+ "app under test with a notification it does not control.")]
	public Task<OperationResult> SendSms(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("The sender's phone number.")] string from,
		[Description("The message body.")] string body,
		CancellationToken cancellationToken = default) =>
		client.SendSmsAsync(deviceId, new SmsRequest { From = from, Body = body }, cancellationToken);

	[McpServerTool(Name = "mobile_device_calls", Title = "List phone calls", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"List the calls the device's telephony stack currently knows about, with the platform's own "
		+ "state for each such as RINGING or ACTIVE. Android only.")]
	public Task<CallStateResult> GetCalls(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.GetCallsAsync(deviceId, cancellationToken);

	[McpServerTool(Name = "mobile_device_call", Title = "Ring, answer or end a call", OpenWorld = false)]
	[Description(
		"Ring the device from a number, or answer, hold or hang up a call already in progress, then "
		+ "read the call list back. Android only. Placing a call needs a number; the other actions "
		+ "apply to the call in progress when no number is given. An incoming call is the classic "
		+ "interruption an app has to survive -- it takes audio focus and moves the app to the "
		+ "background.")]
	public Task<CallStateResult> ChangeCall(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("One of place, accept, hold, or cancel.")] string action,
		[Description("The other party's number. Required to place a call, optional afterwards.")] string? number = null,
		CancellationToken cancellationToken = default) =>
		client.ChangeCallAsync(deviceId, new CallRequest { Action = action, Number = number }, cancellationToken);

	[McpServerTool(Name = "mobile_device_biometric", Title = "Present a biometric scan", OpenWorld = false)]
	[Description(
		"Present a fingerprint or face scan that the device either accepts or rejects, to drive an "
		+ "unlock prompt without any hardware. A rejection is the path worth testing, because it is "
		+ "the one apps most often leave unhandled. On Android the emulator confirms it took the "
		+ "event. On iOS it cannot: the scan is posted to a notification bus that reports nothing "
		+ "back, so 'confirmed' comes back false and the result has to be read from the app itself. "
		+ "The device must already have a biometric enrolled, which is a device setting rather than "
		+ "something this can turn on.")]
	public Task<BiometricResult> Biometric(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Either match to accept the scan, or nomatch to reject it.")] string action,
		[Description("Which enrolled finger to present, on Android. Ignored on iOS.")] int? fingerId = null,
		CancellationToken cancellationToken = default) =>
		client.SendBiometricAsync(
			deviceId,
			new BiometricRequest { Action = action, FingerId = fingerId },
			cancellationToken);

	[McpServerTool(Name = "mobile_device_clipboard_get", Title = "Read the pasteboard", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"Read what is on the device's pasteboard. iOS only -- the Android emulator cannot reach its "
		+ "clipboard from outside, and says so rather than returning an empty string that would look "
		+ "like an empty clipboard.")]
	public Task<ClipboardResult> GetClipboard(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.GetClipboardAsync(deviceId, cancellationToken);

	[McpServerTool(Name = "mobile_device_clipboard_set", Title = "Write the pasteboard", OpenWorld = false)]
	[Description(
		"Put text on the device's pasteboard and read it back, so a paste-into-field flow can be "
		+ "driven without typing. iOS only. Note that the Simulator can be set to share its "
		+ "pasteboard with the host Mac, in which case the host can overwrite what is written here.")]
	public Task<ClipboardResult> SetClipboard(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("The text to place on the pasteboard.")] string text,
		CancellationToken cancellationToken = default) =>
		client.SetClipboardAsync(deviceId, text, cancellationToken);

	[McpServerTool(Name = "mobile_device_media_add", Title = "Add photos or videos", OpenWorld = false)]
	[Description(
		"Copy images or videos from this machine into the device's photo library, so a photo picker "
		+ "or upload flow has something to find. Works on both platforms. iOS also accepts vCard "
		+ "files, which land in Contacts.")]
	public Task<MediaResult> AddMedia(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Absolute paths on this machine to the files to add.")] string[] paths,
		CancellationToken cancellationToken = default) =>
		client.AddMediaAsync(deviceId, new MediaRequest { HostPaths = paths }, cancellationToken);
}
