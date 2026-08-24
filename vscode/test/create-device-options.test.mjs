import assert from "node:assert/strict";
import test from "node:test";
import {
  creatablePlatforms,
  createOptions,
  needsCatalogForCreate,
} from "../../web/create-device-options.js";

const catalog = {
  runtimes: [
    {
      id: "ios-18",
      name: "iOS 18",
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypeIds: ["iphone-16"],
    },
    {
      id: "ios-17",
      name: "iOS 17",
      platform: "ios",
      isAvailable: true,
      supportedDeviceTypeIds: ["iphone-15"],
    },
    {
      id: "android-35",
      name: "Android 15",
      platform: "android",
      isAvailable: true,
      supportedDeviceTypeIds: [],
    },
    {
      id: "tvos-18",
      name: "tvOS 18",
      platform: "tvOS",
      isAvailable: true,
      supportedDeviceTypeIds: [],
    },
  ],
  deviceTypes: [
    { id: "iphone-16", name: "iPhone 16", platform: "ios" },
    { id: "iphone-15", name: "iPhone 15", platform: "ios" },
    { id: "pixel", name: "Pixel", platform: "android" },
    { id: "apple-tv", name: "Apple TV", platform: "tvOS" },
  ],
};

test("create platform choices only include supported mobile platforms", () => {
  assert.deepEqual(creatablePlatforms(catalog), ["ios", "android"]);
});

test("device types follow the selected runtime compatibility list", () => {
  assert.deepEqual(
    createOptions(catalog, "ios", "ios-18").deviceTypes.map((type) => type.id),
    ["iphone-16"],
  );
  assert.deepEqual(
    createOptions(catalog, "ios", "ios-17").deviceTypes.map((type) => type.id),
    ["iphone-15"],
  );
});

test("an empty runtime compatibility list permits every platform device type", () => {
  assert.deepEqual(
    createOptions(catalog, "android", "android-35").deviceTypes.map((type) => type.id),
    ["pixel"],
  );
});

test("a catalog without a creatable platform asks the dialog to reload", () => {
  assert.equal(needsCatalogForCreate(catalog), false);
  assert.equal(needsCatalogForCreate(null), true);
  assert.equal(needsCatalogForCreate({}), true);
  assert.equal(needsCatalogForCreate({ runtimes: catalog.runtimes, deviceTypes: [] }), true);
  assert.equal(needsCatalogForCreate({ runtimes: [], deviceTypes: catalog.deviceTypes }), true);
});
