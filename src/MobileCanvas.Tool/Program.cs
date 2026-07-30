namespace MobileCanvas.Tool;

internal static class Program
{
	public static async Task<int> Main(string[] args)
	{
		try
		{
			if (args.Length >= 2 && args[0] == "host" && args[1] == "run")
				return await DeviceHost.RunAsync().ConfigureAwait(false);
			if (args.Length >= 1 && args[0] == "mcp")
			{
				await DeviceMcpHost.RunAsync().ConfigureAwait(false);
				return 0;
			}
			return await DeviceCli.RunAsync(args).ConfigureAwait(false);
		}
		catch (Exception exception)
		{
			return DeviceCli.WriteError(exception);
		}
	}
}
