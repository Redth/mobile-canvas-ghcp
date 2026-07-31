namespace MobileCanvas.Contracts;

/// <summary>
/// One permission, as the device currently holds it.
/// </summary>
public sealed record DevicePermission
{
	/// <summary>The canonical name when there is one, and the platform's own name otherwise.</summary>
	public string Name { get; init; } = "";

	/// <summary>The platform's own name, which is what to quote when reporting to a developer.</summary>
	public string PlatformName { get; init; } = "";

	/// <summary>
	/// Null when the platform will not say. iOS only records a decision once one has been made, so an
	/// app that has never been asked has no entry -- which is not the same as denied.
	/// </summary>
	public bool? Granted { get; init; }
}

public sealed record PermissionListResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string DeviceId { get; init; } = "";
	public string Platform { get; init; } = "";
	public string BundleId { get; init; } = "";
	public DevicePermission[] Permissions { get; init; } = [];
	public int Total { get; init; }
}

/// <summary>
/// Changes one permission for one app.
/// </summary>
public sealed record PermissionChangeRequest
{
	public string BundleId { get; init; } = "";

	/// <summary>
	/// A canonical name from <see cref="DevicePermissions"/>, or the platform's own name.
	/// </summary>
	public string Permission { get; init; } = "";

	/// <summary>One of the <see cref="PermissionActions"/> values.</summary>
	public string Action { get; init; } = PermissionActions.Grant;
}

public sealed record PermissionChangeResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public bool Success { get; init; } = true;
	public string DeviceId { get; init; } = "";
	public string BundleId { get; init; } = "";
	public string Permission { get; init; } = "";
	public string Action { get; init; } = "";

	/// <summary>
	/// The permissions the change actually touched, read back afterwards rather than assumed. A
	/// canonical name can cover more than one platform permission, and a platform tool can accept a
	/// change it then declines to make.
	/// </summary>
	public DevicePermission[] Permissions { get; init; } = [];
}

public static class PermissionActions
{
	public const string Grant = "grant";
	public const string Revoke = "revoke";

	/// <summary>Forgets the decision, so the app is asked again the next time it needs the permission.</summary>
	public const string Reset = "reset";

	public static readonly string[] All = [Grant, Revoke, Reset];
}

/// <summary>
/// Permission names that mean the same thing on both platforms, so a caller does not have to know
/// that iOS calls it <c>photos</c> and Android calls it
/// <c>android.permission.READ_MEDIA_IMAGES</c>.
/// </summary>
/// <remarks>
/// One canonical name can cover several platform permissions -- Android splits location into fine
/// and coarse, and contacts into read and write -- so a change fans out and the result reports every
/// permission it touched. A name the table does not know is passed through to the platform unchanged,
/// which is how anything outside this list stays reachable.
/// </remarks>
public static class DevicePermissions
{
	public const string Camera = "camera";
	public const string Microphone = "microphone";
	public const string Location = "location";
	public const string LocationAlways = "location-always";
	public const string Contacts = "contacts";
	public const string Calendar = "calendar";
	public const string Reminders = "reminders";
	public const string Photos = "photos";
	public const string PhotosAdd = "photos-add";
	public const string MediaLibrary = "media-library";
	public const string Motion = "motion";
	public const string Notifications = "notifications";

	public static readonly string[] All =
	[
		Camera, Microphone, Location, LocationAlways, Contacts, Calendar,
		Reminders, Photos, PhotosAdd, MediaLibrary, Motion, Notifications,
	];
}
