import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const swiftStartup = `import SwiftUI
import AilohaAgent
@main struct ConsumerApp: App {
  var body: some Scene {
    WindowGroup {
#if DEBUG
      Text("Fixture").ailohaAgent()
#else
      Text("Fixture")
#endif
    }
  }
}`;

function xcodeProject(files, directory, targets) {
  const id = (value) => value.toString(16).toUpperCase().padStart(24, "0");
  const objects = [];
  const targetIds = [];
  const sourceIds = [];
  for (const [index, target] of targets.entries()) {
    const base = 100 + index * 20;
    const key = (offset) => id(base + offset);
    const filename = `${target.name}App.swift`;
    targetIds.push(key(0));
    sourceIds.push(key(3));
    files[`${directory}/${filename}`] = swiftStartup;
    const settings = `SDKROOT = ${target.sdk ?? "iphoneos"}; PRODUCT_BUNDLE_IDENTIFIER = org.example.repeated; ${target.settings ?? ""}`;
    objects.push(`
${key(0)} = { isa = PBXNativeTarget; name = "${target.name}"; productType = "${target.productType ?? "com.apple.product-type.application"}";
  buildConfigurationList = ${key(4)}; buildPhases = (${key(1)}${target.script ? `, ${key(8)}` : ""}); packageProductDependencies = (${key(7)}); };
${key(1)} = { isa = PBXSourcesBuildPhase; files = (${key(2)}); };
${key(2)} = { isa = PBXBuildFile; fileRef = ${key(3)}; };
${key(3)} = { isa = PBXFileReference; path = "${filename}"; sourceTree = "<group>"; };
${key(4)} = { isa = XCConfigurationList; buildConfigurations = (${key(5)}, ${key(6)}); };
${key(5)} = { isa = XCBuildConfiguration; name = Debug; buildSettings = { ${settings} }; };
${key(6)} = { isa = XCBuildConfiguration; name = Release; buildSettings = { ${settings} }; };
${key(7)} = { isa = XCSwiftPackageProductDependency; productName = AilohaAgent; package = ${id(6)}; };
${target.script ? `${key(8)} = { isa = PBXShellScriptBuildPhase; shellPath = /bin/sh; shellScript = ${JSON.stringify(target.script)}; };` : ""}`);
  }
  files[`${directory}/Consumer.xcodeproj/project.pbxproj`] = `// !$*UTF8*$!
{
  archiveVersion = 1; objectVersion = 56;
  objects = {
    ${id(1)} = { isa = PBXProject; mainGroup = ${id(2)}; projectDirPath = ""; projectRoot = "";
      targets = (${targetIds.join(", ")}); buildConfigurationList = ${id(3)}; packageReferences = (${id(6)}); };
    ${id(2)} = { isa = PBXGroup; sourceTree = "<group>"; children = (${sourceIds.join(", ")}); };
    ${id(3)} = { isa = XCConfigurationList; buildConfigurations = (${id(4)}, ${id(5)}); };
    ${id(4)} = { isa = XCBuildConfiguration; name = Debug; buildSettings = {}; };
    ${id(5)} = { isa = XCBuildConfiguration; name = Release; buildSettings = {}; };
    ${id(6)} = { isa = XCRemoteSwiftPackageReference; repositoryURL = "https://github.com/microsoft/ailoha";
      requirement = { kind = upToNextMajorVersion; minimumVersion = 0.1.0; }; };
    ${objects.join("\n")}
  };
  rootObject = ${id(1)};
}`;
}

export function workspaceFixtureFiles({ incomplete = false } = {}) {
  const files = {
    "maui/Consumer.csproj": `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><UseMaui>true</UseMaui><OutputType>Exe</OutputType>
    <TargetFrameworks>net10.0-ios;net10.0-android</TargetFrameworks></PropertyGroup>
  <ItemGroup><PackageReference Include="Ailoha.Agent.Maui" Version="0.1.0" /></ItemGroup>
</Project>`,
    "maui/MauiProgram.cs": `public static class MauiProgram {
  public static object CreateMauiApp() {
#if DEBUG
    builder.Services.AddMauiDevFlowAgent();
#endif
    return builder.Build();
  }
}`,
    "expo/package.json": JSON.stringify({
      name: "ConsumerExpo", main: "expo-router/entry",
      dependencies: { expo: "~55.0.0", "react-native": "0.85.3", "@ailoha/react-native": "^0.1.0", "expo-dev-client": "~5.0.0" },
      scripts: { start: "node WORKSPACE_HOOK_MUST_NOT_RUN" },
    }),
    "expo/app.json": '{"expo":{"name":"ConsumerExpo","platforms":["android","ios"]}}',
    "expo/App.tsx": `import { initAgent } from '@ailoha/react-native';
if (__DEV__) { initAgent({ enableLogCapture: false }); }`,
    "expo/android/settings.gradle": "include ':app'",
    "expo/android/app/build.gradle": `plugins { id 'com.android.application'; id 'com.facebook.react' }
react { root = file("../..") }`,
    "react-native/package.json": '{"name":"ConsumerRN","dependencies":{"react-native":"0.85.3"}}',
    "react-native/index.js": "import { AppRegistry } from 'react-native'; AppRegistry.registerComponent('ConsumerRN', () => App);",
    "swiftpm/Package.swift": 'fatalError("WORKSPACE_HOOK_MUST_NOT_RUN")',
    ".npmrc": "SYNTHETIC_CONFIGURATION_MUST_NOT_BE_READ",
    ".gitignore": "ignored/\n",
    "ignored/package.json": "IGNORED_INPUT_MUST_NOT_BE_READ",
  };
  xcodeProject(files, "native", [
    { name: "PhoneApp", sdk: "iphoneos" },
    { name: "DesktopApp", sdk: "macosx" },
    { name: "SharedLibrary", productType: "com.apple.product-type.framework" },
  ]);
  xcodeProject(files, "expo/ios", [
    { name: "ExpoWrapper", settings: 'PROJECT_ROOT = "..";', script: "/bin/sh ../node_modules/react-native/scripts/react-native-xcode.sh" },
    { name: "IndependentApp" },
  ]);
  if (incomplete) files["broken/package.json"] = '{"dependencies": invalid-json }';
  return files;
}

export function writeWorkspaceFixture(root, options) {
  if (!isAbsolute(root)) throw new Error("Synthetic fixtures require an explicit absolute root.");
  for (const [relative, contents] of Object.entries(workspaceFixtureFiles(options))) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, { flag: "wx" });
  }
}
