import {
  catalogs as validateCatalogs,
  hostStatus,
  isOpaqueId,
  providerDiagnostics,
  providers as validateProviders,
  runtimes as validateRuntimes,
  targetTypes as validateTypes,
  templates as validateTemplates,
} from "./protocol.mjs";
import {
  catalogChoiceId, hasOperation, MobileAilohaError, publicSnapshot, readCatalogChoiceId,
} from "./mobile-projection.mjs";

const READS = Object.freeze([
  ["catalogs", "listProviderCatalogs", validateCatalogs],
  ["runtimes", "listProviderRuntimes", validateRuntimes],
  ["targetTypes", "listProviderTargetTypes", validateTypes],
  ["templates", "listProviderTemplates", validateTemplates],
]);
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const mobilePlatform = (platform) => ["ios", "android"].includes(platform?.toLowerCase())
  ? platform.toLowerCase() : null;
const providerAvailable = (provider) => !["unavailable", "disabled"].includes(provider.state);

function invalidCatalog(message) {
  throw new MobileAilohaError("catalog_inconsistent", message, 502);
}

function metadataStrings(metadata, key, identifiers = false) {
  if (!metadata || !Object.hasOwn(metadata, key)) return undefined;
  const values = metadata[key];
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value
    || (identifiers && !isOpaqueId(value))) || new Set(values).size !== values.length) {
    invalidCatalog(`The authoritative runtime ${key} metadata is malformed or ambiguous.`);
  }
  return values;
}

function nativeDiagnostics(catalogs) {
  const results = new Map();
  for (const catalog of catalogs) {
    if (!catalog.metadata || !Object.hasOwn(catalog.metadata, "diagnostics")) continue;
    const entries = catalog.metadata.diagnostics;
    if (!Array.isArray(entries)) invalidCatalog("Catalog dependency diagnostics must be an array.");
    for (const entry of entries) {
      if (!entry || typeof entry.platform !== "string" || typeof entry.available !== "boolean"
        || typeof entry.ready !== "boolean" || !Array.isArray(entry.checks)
        || entry.checks.some((check) => !check || typeof check.name !== "string"
          || typeof check.status !== "string" || typeof check.message !== "string"
          || (check.actions !== undefined && (!Array.isArray(check.actions)
            || check.actions.some((action) => !action || !["type", "target", "label"]
              .every((field) => typeof action[field] === "string")))))) {
        invalidCatalog("Catalog dependency diagnostics do not match the advertised Mobile Canvas metadata.");
      }
      let unsupportedActions = false;
      const checks = entry.checks.map((check) => ({
        ...check,
        actions: (check.actions ?? []).filter((action) => {
          if (action.type === "open-url" && action.target.startsWith("https://")) return true;
          unsupportedActions = true;
          return false;
        }),
      }));
      if (unsupportedActions) checks.push({
        name: "Ailoha diagnostic actions", status: "warning", actions: [],
        message: "Native settings and other diagnostic actions are guidance only in this opt-in; they are retained in providerCatalogs but are not enabled controls.",
      });
      results.set(JSON.stringify(entry), { ...entry, checks });
    }
  }
  return [...results.values()];
}

export async function loadMobileCatalog({ hostId, client, providers, devices, options }) {
  validateProviders(providers);
  if (providers.length > 64) {
    throw new MobileAilohaError("catalog_limit", "The bounded Mobile Canvas provider catalog pool is full.", 502);
  }
  const status = await client.getHostStatus(options);
  hostStatus(status);
  if (status.hostId !== hostId) {
    throw new MobileAilohaError("host_identity_mismatch", "The catalog belongs to a different Ailoha Target Host.", 502);
  }
  const providerCatalogs = [];
  let bytes = 0;
  for (const provider of providers) {
    const advertised = READS.filter(([, operation]) => hasOperation(provider.capabilities, operation, "provider.catalog"));
    const entry = {
      targetHostId: hostId, providerId: provider.providerId,
      advertisedOperations: advertised.map(([, operation]) => operation),
      catalogs: [], runtimes: [], targetTypes: [], templates: [],
    };
    const responses = await Promise.all(advertised.map(async ([field, method, validate]) => {
      const value = await client[method](provider.providerId, options);
      validate(value);
      if (value.some((record) => record.providerId !== provider.providerId)) {
        invalidCatalog("A provider returned catalog records belonging to another provider.");
      }
      return [field, value];
    }));
    Object.assign(entry, Object.fromEntries(responses));
    if (hasOperation(provider.capabilities, "getProviderDiagnostics", "provider.administration")) {
      entry.diagnostics = await client.getProviderDiagnostics(provider.providerId, options);
      providerDiagnostics(entry.diagnostics);
      if (entry.diagnostics.providerId !== provider.providerId) invalidCatalog("Provider diagnostics changed their owner.");
    }
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes > MAX_CATALOG_BYTES) {
      throw new MobileAilohaError("catalog_limit", "The combined provider catalogs exceed the bounded response budget.", 502);
    }
    providerCatalogs.push(entry);
  }
  return projectMobileCatalog({ hostId, status, providers, devices, providerCatalogs });
}

export function projectMobileCatalog({ hostId, status, providers, devices, providerCatalogs }) {
  hostStatus(status);
  validateProviders(providers);
  if (status.hostId !== hostId || providerCatalogs.length !== providers.length
    || new Set(providerCatalogs.map((entry) => entry.providerId)).size !== providerCatalogs.length) {
    invalidCatalog("The complete catalog must preserve one exact record for each host/provider identity.");
  }
  const runtimes = [];
  const deviceTypes = [];
  const diagnostics = [];
  const completeness = [];
  const providerSupport = [];
  const hostCreates = ["createTarget", "startTarget"].every((operation) =>
    hasOperation(status.capabilities, operation, "target.lifecycle"));
  for (const provider of providers) {
    const entry = providerCatalogs.find((candidate) => candidate.providerId === provider.providerId);
    if (!entry || entry.targetHostId !== hostId) invalidCatalog("A provider catalog changed its captured host identity.");
    const advertised = READS.filter(([, operation]) => hasOperation(provider.capabilities, operation, "provider.catalog"))
      .map(([, operation]) => operation);
    if (JSON.stringify(entry.advertisedOperations) !== JSON.stringify(advertised)) {
      invalidCatalog("Catalog data must use exactly the selected provider's advertised read operations.");
    }
    for (const [field, , validate] of READS) {
      validate(entry[field]);
      if (entry[field].some((record) => record.providerId !== provider.providerId)) {
        invalidCatalog("A catalog descriptor changed its captured provider identity.");
      }
    }
    const complete = entry.advertisedOperations.includes("listProviderTargetTypes")
      && (entry.advertisedOperations.includes("listProviderRuntimes")
        || entry.advertisedOperations.includes("listProviderTemplates"));
    completeness.push(entry.advertisedOperations.length === 0 ? "inventory-only" : complete ? "complete" : "partial");
    const identity = { targetHostId: hostId, providerId: provider.providerId };
    const available = providerAvailable(provider) && (!entry.diagnostics || providerAvailable(entry.diagnostics));
    const creates = complete && hostCreates && available && ["createTarget", "startTarget"].every((operation) =>
      hasOperation(provider.capabilities, operation, "target.lifecycle"));
    const types = entry.targetTypes.map((type) => ({
      id: catalogChoiceId("target-type", { ...identity, targetTypeId: type.targetTypeId }),
      name: type.name, platform: mobilePlatform(type.platform) ?? type.platform ?? "unknown",
      targetTypeId: type.targetTypeId,
      catalogSelection: { ...identity, targetTypeId: type.targetTypeId },
      isCreatable: false,
    }));
    const eligible = (type) => creates && mobilePlatform(type.platform)
      && type.kind === (mobilePlatform(type.platform) === "ios" ? "simulator" : "emulator")
      && ["createTarget", "startTarget"].every((operation) => hasOperation(type.capabilities ?? [], operation, "target.lifecycle"))
      && (!type.configSchema || Object.keys(type.configSchema).length === 0);
    const choices = [];
    for (const runtime of entry.runtimes) {
      const supported = metadataStrings(runtime.metadata, "supportedDeviceTypeIds", true);
      const architectures = metadataStrings(runtime.metadata, "supportedArchitectures")
        ?? (runtime.architecture ? [runtime.architecture] : []);
      if (runtime.architecture && architectures.length && !architectures.includes(runtime.architecture)) {
        invalidCatalog("Runtime architecture conflicts with its authoritative supported architectures.");
      }
      if (supported?.some((id) => !entry.targetTypes.some((type) => type.targetTypeId === id))) {
        invalidCatalog("Runtime compatibility references a missing target type in this provider catalog.");
      }
      const compatible = supported === undefined ? [] : entry.targetTypes.filter((type) =>
        (supported.length === 0 || supported.includes(type.targetTypeId))
        && mobilePlatform(type.platform) === mobilePlatform(runtime.platform));
      if (supported?.some((id) => {
        const type = entry.targetTypes.find((candidate) => candidate.targetTypeId === id);
        return type.platform !== undefined && type.platform.toLowerCase() !== runtime.platform.toLowerCase();
      })) invalidCatalog("Runtime compatibility crosses authoritative platform boundaries.");
      const typeIds = compatible.filter(eligible).map((type) =>
        catalogChoiceId("target-type", { ...identity, targetTypeId: type.targetTypeId }));
      choices.push({
        id: catalogChoiceId("runtime", { ...identity, runtimeId: runtime.runtimeId }),
        name: runtime.name, version: runtime.version,
        platform: mobilePlatform(runtime.platform) ?? runtime.platform,
        isAvailable: available && runtime.state === "available",
        supportedArchitectures: architectures,
        supportedDeviceTypeIds: typeIds,
        isCreatable: runtime.state === "available" && typeIds.length > 0,
        catalogSelection: { ...identity, runtimeId: runtime.runtimeId },
        ...(!typeIds.length ? { creationUnavailableReason: supported === undefined
          ? "No authoritative runtime/type compatibility was advertised; template choices are required."
          : "No compatible target type advertises supported create+boot without additional configuration." } : {}),
      });
    }
    for (const template of entry.templates) {
      const type = entry.targetTypes.find((candidate) => candidate.targetTypeId === template.targetTypeId);
      const runtime = template.runtimeId === undefined ? undefined
        : entry.runtimes.find((candidate) => candidate.runtimeId === template.runtimeId);
      if (!type || (template.runtimeId !== undefined && !runtime)) {
        invalidCatalog("A template references a missing runtime or target type in this provider catalog.");
      }
      if (runtime && type.platform !== undefined && runtime.platform.toLowerCase() !== type.platform.toLowerCase()) {
        invalidCatalog("A template combines different authoritative platforms.");
      }
      const supported = metadataStrings(runtime?.metadata, "supportedDeviceTypeIds", true);
      if (supported?.length && !supported.includes(type.targetTypeId)) {
        invalidCatalog("A template contradicts the runtime's authoritative compatibility constraints.");
      }
      const templateAvailable = available && (!runtime || runtime.state === "available");
      choices.push({
        id: catalogChoiceId("template", { ...identity, templateId: template.templateId }),
        name: template.name, version: runtime?.version ?? "",
        platform: mobilePlatform(type.platform) ?? type.platform ?? "unknown",
        isAvailable: templateAvailable,
        supportedArchitectures: metadataStrings(runtime?.metadata, "supportedArchitectures")
          ?? (runtime?.architecture ? [runtime.architecture] : []),
        supportedDeviceTypeIds: [catalogChoiceId("target-type", { ...identity, targetTypeId: type.targetTypeId })],
        isCreatable: Boolean(templateAvailable && eligible(type)),
        catalogSelection: {
          ...identity, targetTypeId: type.targetTypeId, templateId: template.templateId,
          ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
        },
      });
    }
    for (const type of types) {
      type.isCreatable = choices.some((choice) => choice.isCreatable && choice.supportedDeviceTypeIds.includes(type.id));
    }
    runtimes.push(...choices);
    deviceTypes.push(...types);
    const native = nativeDiagnostics(entry.catalogs);
    const platforms = [...new Set([
      ...entry.runtimes.map((runtime) => runtime.platform),
      ...entry.targetTypes.map((type) => type.platform),
      ...devices.filter((device) => device.provider === provider.providerId).map((device) => device.platform),
    ].filter((platform) => platform && platform !== "unknown"))];
    diagnostics.push(...(native.length ? native : [{
      platform: platforms.length === 1 ? platforms[0] : "ailoha",
      available: providerAvailable(provider), ready: provider.state === "ready",
      checks: entry.diagnostics ? entry.diagnostics.checks.map((check) => ({
        name: check.name, status: { pass: "ok", warn: "warning", fail: "error" }[check.status],
        message: check.detail ?? `${check.name}: provider reported ${check.status} without diagnostic detail.`, actions: [],
      })) : [{
        name: provider.name,
        status: provider.state === "ready" ? "ok" : provider.state === "degraded" ? "warning" : "error",
        message: provider.description ?? `Ailoha provider ${provider.name} is ${provider.state}.`, actions: [],
      }],
    }]).map((diagnostic) => ({ ...diagnostic, providerId: provider.providerId, providerState: provider.state })));
    if (native.length && entry.diagnostics) diagnostics.push({
      platform: platforms.length === 1 ? platforms[0] : "ailoha",
      providerId: provider.providerId, providerState: entry.diagnostics.state,
      available: providerAvailable(entry.diagnostics),
      ready: entry.diagnostics.state === "ready" && !entry.diagnostics.checks.some((check) => check.status === "fail"),
      checks: entry.diagnostics.checks.map((check) => ({
        name: check.name, status: { pass: "ok", warn: "warning", fail: "error" }[check.status],
        message: check.detail ?? `${check.name}: provider reported ${check.status} without diagnostic detail.`, actions: [],
      })),
    });
    const supported = choices.some((choice) => choice.isCreatable);
    providerSupport.push({
      ...identity, supported,
      ...(!supported ? { reason: "Creation needs available compatible catalog choices and host/provider/type create+boot capability evidence; configuration-dependent and incomplete choices are not enabled." } : {}),
    });
  }
  const result = {
    schemaVersion: "1.0", backend: "ailoha", targetHostId: hostId,
    catalogCompleteness: completeness.every((value) => value === "inventory-only") ? "inventory-only"
      : completeness.every((value) => value === "complete") ? "complete" : "partial",
    providers, providerCatalogs, devices, runtimes, deviceTypes,
    creationSupport: { supported: providerSupport.some((provider) => provider.supported), providers: providerSupport },
    diagnostics: [...diagnostics, {
      platform: "ailoha", available: providers.some(providerAvailable),
      ready: providers.length > 0 && providers.every((provider) => provider.state === "ready"),
      checks: [{
        name: "Ailoha opt-in", status: "warning",
        message: "Only advertised catalog/create+boot choices and supported target controls are enabled. Recording requires target capture capability and a bound view; app inspection and broader controls remain unsupported.",
        actions: [],
      }],
    }],
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_CATALOG_BYTES) {
    throw new MobileAilohaError("catalog_limit", "The projected catalog exceeds the bounded response budget.", 502);
  }
  return publicSnapshot(result);
}

export function captureCreateInput(input) {
  const allowed = ["platform", "name", "runtimeId", "deviceTypeId"];
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.getOwnPropertySymbols(input).length || Object.getOwnPropertyNames(input).some((key) => !allowed.includes(key))
    || Object.getOwnPropertyNames(input).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string";
    })) {
    throw new MobileAilohaError("invalid_request", "Creation accepts only literal platform/name/runtimeId/deviceTypeId fields; extra configuration is unsupported.", 400);
  }
  if (!["name", "runtimeId", "deviceTypeId"].every((key) => Object.hasOwn(input, key))
    || !input.name.trim() || !isOpaqueId(input.runtimeId) || !isOpaqueId(input.deviceTypeId)
    || (Object.hasOwn(input, "platform") && !["ios", "android"].includes(input.platform.toLowerCase()))) {
    throw new MobileAilohaError("invalid_request", "Creation requires a name, exact catalog choices and a supported mobile platform.", 400);
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) {
    throw new MobileAilohaError("request_too_large", "The creation request exceeds the bounded JSON contract.", 413);
  }
  return publicSnapshot({ ...input, platform: input.platform?.toLowerCase() ?? "ios" });
}

export function resolveCreateChoice(catalog, input) {
  const runtimeIdentity = readCatalogChoiceId(input.runtimeId);
  const typeIdentity = readCatalogChoiceId(input.deviceTypeId);
  if (runtimeIdentity.targetHostId !== catalog.targetHostId || typeIdentity.targetHostId !== catalog.targetHostId) {
    throw new MobileAilohaError("host_selection_mismatch", "Creation choices belong to a different Target Host.");
  }
  if (runtimeIdentity.providerId !== typeIdentity.providerId || !typeIdentity.targetTypeId
    || (!runtimeIdentity.runtimeId && !runtimeIdentity.templateId)) {
    throw new MobileAilohaError("incompatible_catalog_choice", "Creation choices must identify one exact provider/runtime-or-template/target-type combination.", 400);
  }
  const provider = catalog.providers.find((candidate) => candidate.providerId === runtimeIdentity.providerId);
  if (!provider || !providerAvailable(provider)) {
    throw new MobileAilohaError("provider_unavailable", "The chosen creation provider is unavailable.", 503);
  }
  const runtime = catalog.runtimes.find((candidate) => candidate.id === input.runtimeId);
  const type = catalog.deviceTypes.find((candidate) => candidate.id === input.deviceTypeId);
  if (!runtime || !type) {
    throw new MobileAilohaError("invalid_catalog_choice", "The chosen runtime/template or device type is no longer in its authoritative catalog.", 400);
  }
  if (!runtime.isAvailable) throw new MobileAilohaError("runtime_unavailable", "The chosen runtime or template is unavailable.", 409);
  const platform = input.platform?.toLowerCase() ?? "ios";
  if (!platform || runtime.platform !== platform || type.platform !== platform
    || (runtime.catalogSelection.targetTypeId && runtime.catalogSelection.targetTypeId !== type.targetTypeId)) {
    throw new MobileAilohaError("incompatible_catalog_choice", "The selected platform, runtime/template and target type do not match.", 400);
  }
  if (!runtime.isCreatable || !type.isCreatable) {
    throw new MobileAilohaError("capability_not_supported", "This catalog choice lacks complete create+boot capability/compatibility evidence or requires unsupported configuration.", 501);
  }
  if (!runtime.supportedDeviceTypeIds.includes(type.id)) {
    throw new MobileAilohaError("incompatible_catalog_choice", "The authoritative runtime does not support this target type.", 400);
  }
  const { runtimeId, templateId } = runtime.catalogSelection;
  return publicSnapshot({
    platform,
    request: {
      providerId: provider.providerId, targetTypeId: type.targetTypeId, name: input.name, start: true,
      ...(runtimeId ? { runtimeId } : {}),
      ...(templateId ? { templateId } : {}),
    },
  });
}
