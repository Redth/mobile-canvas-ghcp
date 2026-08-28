# Set up Android Emulator support

Mobile Canvas needs the Android SDK to discover, start, and control Android
emulators. It does not require Xcode.

## Install the required SDK packages

The easiest setup is Android Studio. Open **Tools > SDK Manager** and install:

- **Android SDK Platform-Tools**, which provides `adb`
- **Android Emulator**, which provides the `emulator` executable
- At least one Android system image and an AVD that uses it

Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` when the SDK is not installed in the
platform's default location:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

On Windows or Linux, use the Android SDK location for that platform instead.

Verify the required tools:

```bash
adb version
emulator -version
emulator -list-avds
```

## Creating and deleting AVDs

Running and controlling an existing AVD only needs `adb` and `emulator`. Java is
not a general Mobile Canvas requirement.

Mobile Canvas uses `avdmanager` when it creates or deletes an AVD. For those
operations, also install **Android SDK Command-line Tools (latest)** and make a
compatible Java runtime available through `JAVA_HOME` or `PATH`. Android
Studio's bundled runtime can be used when it is exposed to command-line tools.

Verify the optional AVD-management path:

```bash
avdmanager list device -c
```

If this command reports that Java is missing, configure a JDK before creating
or deleting AVDs. Existing emulators remain usable without `avdmanager`.
