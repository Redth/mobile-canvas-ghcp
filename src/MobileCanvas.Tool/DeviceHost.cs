using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using MobileCanvas.Android;
using MobileCanvas.iOS;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace MobileCanvas.Tool;

internal static class DeviceHost
{
	public static async Task<int> RunAsync(CancellationToken cancellationToken = default)
	{
		DevicePaths.EnsureHome();
		await using var singletonLock = TryAcquireSingletonLock();
		if (singletonLock is null)
			return 0;

		var controlToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
		var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
		var metadataStore = new HostMetadataStore();
		var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [] });
		builder.Logging.ClearProviders();
		builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
		builder.Services.ConfigureHttpJsonOptions(options =>
			options.SerializerOptions.TypeInfoResolverChain.Insert(0, DeviceJsonContext.Default));
		builder.Services.AddSingleton<IProcessRunner, SystemProcessRunner>();
		builder.Services.AddSingleton<MacSystemSettingsLauncher>();
		builder.Services.AddSingleton<IosSimulatorBackend>();
		builder.Services.AddSingleton<IDeviceBackend>(services =>
			services.GetRequiredService<IosSimulatorBackend>());
		builder.Services.AddSingleton<AndroidEmulatorBackend>();
		builder.Services.AddSingleton<IDeviceBackend>(services =>
			services.GetRequiredService<AndroidEmulatorBackend>());
		builder.Services.AddSingleton(services =>
			new DeviceService(services.GetServices<IDeviceBackend>()));
		builder.Services.AddSingleton<CanvasBootstrapStore>();
		builder.Services.AddSingleton<AutomationActivityHub>();
		builder.Services.AddSingleton(new HostSecurity(controlToken));

		var app = builder.Build();
		app.UseWebSockets();
		DeviceApi.Map(app);

		try
		{
			await app.StartAsync(cancellationToken).ConfigureAwait(false);
			var addresses = app.Services.GetRequiredService<IServer>()
				.Features.Get<IServerAddressesFeature>()?.Addresses;
			var address = addresses?.SingleOrDefault()
				?? throw new InvalidOperationException("Kestrel did not publish its loopback address.");
			var port = new Uri(address).Port;
			metadataStore.Write(new HostMetadata
			{
				ProcessId = Environment.ProcessId,
				Port = port,
				ControlToken = controlToken,
				Version = version,
				StartedAt = DateTimeOffset.UtcNow,
			});
			await app.WaitForShutdownAsync(cancellationToken).ConfigureAwait(false);
			return 0;
		}
		finally
		{
			await app.StopAsync(CancellationToken.None).ConfigureAwait(false);
			await app.DisposeAsync().ConfigureAwait(false);
			metadataStore.DeleteIfOwnedBy(Environment.ProcessId);
		}
	}

	private static FileStream? TryAcquireSingletonLock()
	{
		try
		{
			var stream = new FileStream(
				DevicePaths.Lock,
				FileMode.OpenOrCreate,
				FileAccess.ReadWrite,
				FileShare.None);
			if (!OperatingSystem.IsWindows())
			{
				File.SetUnixFileMode(
					DevicePaths.Lock,
					UnixFileMode.UserRead | UnixFileMode.UserWrite);
			}
			return stream;
		}
		catch (IOException)
		{
			return null;
		}
	}
}

internal sealed record HostSecurity(string ControlToken);
