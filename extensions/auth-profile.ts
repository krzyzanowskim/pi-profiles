import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const PROFILE_FLAG = "auth-profile";
const PROFILE_ENV = "PI_AUTH_PROFILE";
const PROFILE_DIR_ENV = "PI_AUTH_PROFILE_DIR";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
const STRICT_ENV = "PI_AUTH_PROFILE_STRICT_ENV";
const PROFILES_DIR_ENV = "PI_AUTH_PROFILES_DIR";
const SYNCABLE_KEYS = ["packages", "npmCommand", "extensions", "skills", "prompts", "themes", "enableSkillCommands", "mcp"];
const FILE_SYNC_KEYS = new Set(["mcp"]);
const RESOURCE_SYNC_KEYS = new Set(["extensions", "skills", "prompts", "themes"]);
const AUTH_SETTING_KEY_PATTERN = /auth|oauth|token|api[-_]?key|secret|credential|password/i;

type ProfileInfo = {
  profile: string | undefined;
  profileDir: string | undefined;
  agentDir: string | undefined;
  authPath: string | undefined;
  sessionDir: string | undefined;
  expectedAgentDir: string | undefined;
  strictEnv: boolean;
  mismatch: string | undefined;
};

type ProfileSyncConfig = {
  enabled?: boolean;
  from?: string;
  keys?: string[];
  exclude?: string[];
  autoOptOut?: string[];
  state?: {
    lastSynced?: Record<string, unknown>;
    lastSyncedHashes?: Record<string, string>;
    syncedKeys?: string[];
  };
  mode?: "replace" | "all-except";
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function profilesBaseDir(): string {
  return resolve(expandHome(process.env[PROFILES_DIR_ENV] || "~/.pi/agent-profiles"));
}

function validateProfileName(profile: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(profile) && profile !== "." && profile !== "..";
}

function profileDirForName(profile: string): string {
  if (profile === "default") return resolve(expandHome("~/.pi/agent"));
  if (!validateProfileName(profile)) throw new Error(`Invalid profile name: ${profile}`);
  return join(profilesBaseDir(), profile);
}

function listProfiles(): string[] {
  const base = profilesBaseDir();
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJsonFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function profileSyncConfigPath(profileDir: string): string {
  return join(profileDir, "profile-sync.json");
}

function profileSyncStatePath(profileDir: string): string {
  return join(profileDir, "profile-sync-state.json");
}

function isLocalSource(source: string): boolean {
  return source === "." || source === ".." || source.startsWith("./") || source.startsWith("../") || source.startsWith("/") || source.startsWith("~/");
}

function absolutizePath(value: string, baseDir: string): string {
  if (value === "~" || value.startsWith("~/")) return resolve(expandHome(value));
  if (isAbsolute(value)) return value;
  return resolve(baseDir, value);
}

function absolutizePattern(value: string, baseDir: string): string {
  const prefix = value.startsWith("!") || value.startsWith("+") || value.startsWith("-") ? value.slice(0, 1) : "";
  const body = prefix ? value.slice(1) : value;
  if (!body || body.startsWith("*") || body.startsWith("?")) return value;
  return `${prefix}${absolutizePath(body, baseDir)}`;
}

function normalizeSyncedValue(key: string, value: unknown, sourceDir: string): unknown {
  if (key === "packages" && Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === "string") return isLocalSource(entry) ? absolutizePath(entry, sourceDir) : entry;
      if (!entry || typeof entry !== "object" || typeof (entry as { source?: unknown }).source !== "string") return entry;
      const source = (entry as { source: string }).source;
      return {
        ...entry,
        source: isLocalSource(source) ? absolutizePath(source, sourceDir) : source,
      };
    });
  }

  if (RESOURCE_SYNC_KEYS.has(key) && Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? absolutizePattern(entry, sourceDir) : entry));
  }

  return value;
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function valueHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isAuthSettingKey(key: string): boolean {
  return AUTH_SETTING_KEY_PATTERN.test(key);
}

function syncCandidateKeys(config: ProfileSyncConfig, sourceSettings: Record<string, unknown>): string[] {
  const excluded = new Set(Array.isArray(config.exclude) ? config.exclude.filter((key): key is string => typeof key === "string") : []);
  const autoOptOut = new Set(Array.isArray(config.autoOptOut) ? config.autoOptOut.filter((key): key is string => typeof key === "string") : []);

  if (Array.isArray(config.keys)) {
    return config.keys.filter((key) => typeof key === "string" && !excluded.has(key) && !autoOptOut.has(key) && !isAuthSettingKey(key));
  }

  return [...Object.keys(sourceSettings), ...FILE_SYNC_KEYS].filter((key) => !excluded.has(key) && !autoOptOut.has(key) && !isAuthSettingKey(key));
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function syncMcpFile(sourceDir: string, targetDir: string, lastSyncedHashes: Record<string, string>, syncedKeys: Set<string>, autoOptOut: Set<string>): { fileChanged: boolean; stateChanged: boolean } {
  const key = "mcp";
  const sourcePath = join(sourceDir, "mcp.json");
  const targetPath = join(targetDir, "mcp.json");
  const hadSyncedValue = typeof lastSyncedHashes[key] === "string";
  const wasSynced = syncedKeys.has(key);
  const hasTargetValue = existsSync(targetPath);

  const targetChangedLocally = hadSyncedValue ? !hasTargetValue || fileHash(targetPath) !== lastSyncedHashes[key] : false;
  if (targetChangedLocally) {
    autoOptOut.add(key);
    delete lastSyncedHashes[key];
    syncedKeys.delete(key);
    return { fileChanged: false, stateChanged: true };
  }

  if (!existsSync(sourcePath)) {
    const fileChanged = wasSynced && hasTargetValue;
    if (fileChanged) unlinkSync(targetPath);
    delete lastSyncedHashes[key];
    syncedKeys.delete(key);
    return { fileChanged, stateChanged: wasSynced || hadSyncedValue };
  }

  const nextHash = fileHash(sourcePath);
  const previousHash = lastSyncedHashes[key];
  const fileChanged = !hasTargetValue || fileHash(targetPath) !== nextHash;
  if (fileChanged) {
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
  lastSyncedHashes[key] = nextHash;
  syncedKeys.add(key);
  return { fileChanged, stateChanged: !wasSynced || previousHash !== nextHash || fileChanged };
}

function applyProfileSync(targetProfile: string): string[] {
  const targetDir = profileDirForName(targetProfile);
  const configPath = profileSyncConfigPath(targetDir);
  const statePath = profileSyncStatePath(targetDir);
  const config = readJsonFile<ProfileSyncConfig>(configPath, {});
  const persistedState = readJsonFile<NonNullable<ProfileSyncConfig["state"]> & { autoOptOut?: string[] }>(statePath, {});
  if (config.enabled === false) return [];

  const sourceProfile = config.from?.trim() || "default";
  const sourceDir = profileDirForName(sourceProfile);
  const sourceSettingsPath = join(sourceDir, "settings.json");
  if (!existsSync(sourceSettingsPath)) return [];

  const sourceSettings = readJsonFile<Record<string, unknown>>(sourceSettingsPath, {});
  const targetSettingsPath = join(targetDir, "settings.json");
  const targetSettings = readJsonFile<Record<string, unknown>>(targetSettingsPath, {});
  const state = { ...(config.state ?? {}), ...persistedState };
  const legacyLastSynced = state.lastSynced && typeof state.lastSynced === "object" ? state.lastSynced : {};
  const lastSyncedHashes = state.lastSyncedHashes && typeof state.lastSyncedHashes === "object" ? state.lastSyncedHashes : {};
  for (const [key, value] of Object.entries(legacyLastSynced)) {
    if (typeof lastSyncedHashes[key] !== "string") lastSyncedHashes[key] = valueHash(value);
  }
  const syncedKeys = new Set(Array.isArray(state.syncedKeys) ? state.syncedKeys.filter((key): key is string => typeof key === "string") : []);
  const autoOptOut = new Set([
    ...(Array.isArray(config.autoOptOut) ? config.autoOptOut.filter((key): key is string => typeof key === "string") : []),
    ...(Array.isArray(state.autoOptOut) ? state.autoOptOut.filter((key): key is string => typeof key === "string") : []),
  ]);

  const changed: string[] = [];
  let configChanged = false;
  const candidateKeys = new Set([...syncCandidateKeys(config, sourceSettings), ...syncedKeys]);

  for (const key of candidateKeys) {
    if (typeof key !== "string" || isAuthSettingKey(key) || autoOptOut.has(key)) continue;
    if (key === "mcp") {
      const result = syncMcpFile(sourceDir, targetDir, lastSyncedHashes as Record<string, string>, syncedKeys, autoOptOut);
      if (result.fileChanged) changed.push(key);
      if (result.stateChanged) configChanged = true;
      continue;
    }

    const hadSyncedValue = typeof lastSyncedHashes[key] === "string";
    const wasSynced = syncedKeys.has(key);
    const hasTargetValue = Object.prototype.hasOwnProperty.call(targetSettings, key);
    const targetChangedLocally = hadSyncedValue
      ? !hasTargetValue || valueHash(targetSettings[key]) !== lastSyncedHashes[key]
      : hasTargetValue && (!Object.prototype.hasOwnProperty.call(sourceSettings, key) || !stableEqual(targetSettings[key], normalizeSyncedValue(key, sourceSettings[key], sourceDir)));

    if (targetChangedLocally) {
      autoOptOut.add(key);
      delete lastSyncedHashes[key];
      syncedKeys.delete(key);
      configChanged = true;
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(sourceSettings, key)) {
      if (wasSynced && hasTargetValue) {
        delete targetSettings[key];
        changed.push(key);
      }
      delete lastSyncedHashes[key];
      syncedKeys.delete(key);
      configChanged = true;
      continue;
    }

    const nextValue = normalizeSyncedValue(key, sourceSettings[key], sourceDir);
    if (!stableEqual(targetSettings[key], nextValue)) {
      targetSettings[key] = nextValue;
      changed.push(key);
    }
    lastSyncedHashes[key] = valueHash(nextValue);
    syncedKeys.add(key);
    configChanged = true;
  }

  if (changed.length > 0) writeJsonFile(targetSettingsPath, targetSettings);
  if (configChanged) {
    writeJsonFile(statePath, { autoOptOut: [...autoOptOut].sort(), lastSyncedHashes, syncedKeys: [...syncedKeys].sort() });
    if (existsSync(configPath) && (config.state || config.autoOptOut)) {
      const { state: _state, autoOptOut: _autoOptOut, ...cleanConfig } = config;
      writeJsonFile(configPath, cleanConfig);
    }
  }
  return changed;
}

function stringFlag(value: boolean | string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getProfileInfo(pi: ExtensionAPI): ProfileInfo {
  const flagProfile = stringFlag(pi.getFlag(PROFILE_FLAG));
  const envProfile = process.env[PROFILE_ENV]?.trim() || undefined;
  const profile = flagProfile ?? envProfile;
  const profileDir = process.env[PROFILE_DIR_ENV]?.trim() || undefined;
  const agentDir = process.env[AGENT_DIR_ENV]?.trim() || undefined;
  const expectedAgentDir = profileDir ? resolve(profileDir) : undefined;
  const actualAgentDir = agentDir ? resolve(agentDir) : undefined;
  const sessionDir = process.env[SESSION_DIR_ENV]?.trim() || undefined;
  const authPath = actualAgentDir ? join(actualAgentDir, "auth.json") : undefined;

  let mismatch: string | undefined;
  if (flagProfile && envProfile && flagProfile !== envProfile) {
    mismatch = `--${PROFILE_FLAG}=${flagProfile} but ${PROFILE_ENV}=${envProfile}`;
  } else if (expectedAgentDir && actualAgentDir && expectedAgentDir !== actualAgentDir) {
    mismatch = `${AGENT_DIR_ENV}=${actualAgentDir} does not match ${PROFILE_DIR_ENV}=${expectedAgentDir}`;
  } else if (flagProfile && !agentDir) {
    mismatch = `--${PROFILE_FLAG} was set, but ${AGENT_DIR_ENV} is not set. Use the pi-profile launcher so auth is selected before Pi starts.`;
  }

  return {
    profile,
    profileDir: expectedAgentDir,
    agentDir: actualAgentDir,
    authPath,
    sessionDir: sessionDir ? resolve(sessionDir) : undefined,
    expectedAgentDir,
    strictEnv: process.env[STRICT_ENV] !== "0",
    mismatch,
  };
}

function providerSummary(ctx: ExtensionContext): string {
  const providers = ctx.modelRegistry.authStorage.list().sort();
  return providers.length === 0 ? "none stored yet" : providers.join(", ");
}

function formatSyncConfig(targetProfile: string): string {
  const targetDir = profileDirForName(targetProfile);
  const configPath = profileSyncConfigPath(targetDir);
  const config = readJsonFile<ProfileSyncConfig>(configPath, {});
  const state = readJsonFile<NonNullable<ProfileSyncConfig["state"]> & { autoOptOut?: string[] }>(profileSyncStatePath(targetDir), {});
  if (config.enabled === false) return "Profile sync: disabled";

  const source = config.from ?? "default";
  const excluded = Array.isArray(config.exclude) ? config.exclude : [];
  const autoOptOut = [...(Array.isArray(config.autoOptOut) ? config.autoOptOut : []), ...(Array.isArray(state.autoOptOut) ? state.autoOptOut : [])];
  const scope = Array.isArray(config.keys) ? `keys: ${config.keys.join(", ") || "none"}` : "all non-auth settings";
  const suffix = [
    excluded.length ? `excluded: ${excluded.join(", ")}` : undefined,
    autoOptOut.length ? `local overrides: ${autoOptOut.join(", ")}` : undefined,
  ].filter(Boolean).join("; ");

  return `Profile sync: from ${source}; ${scope}${suffix ? `; ${suffix}` : ""}${existsSync(configPath) ? "" : " (default)"}`;
}

function formatInfo(info: ProfileInfo, ctx: ExtensionContext): string {
  const lines = [
    `Auth profile: ${info.profile ?? "(not set)"}`,
    `Agent dir: ${info.agentDir ?? "(default ~/.pi/agent)"}`,
    `Auth file: ${info.authPath ?? "(default auth.json)"}`,
    `Session dir: ${info.sessionDir ?? "(profile/default)"}`,
    `Stored providers: ${providerSummary(ctx)}`,
    `Global env auth cleared by launcher: ${info.strictEnv ? "yes" : "no"}`,
  ];

  if (info.authPath) {
    lines.push(`Auth file exists: ${existsSync(info.authPath) ? "yes" : "no"}`);
  }
  if (info.profile) {
    lines.push(formatSyncConfig(info.profile));
  }
  if (info.mismatch) {
    lines.push(`Warning: ${info.mismatch}`);
  }

  return lines.join("\n");
}

async function configureProfileSync(args: string, ctx: ExtensionContext) {
  const targetProfile = process.env[PROFILE_ENV]?.trim();
  if (!targetProfile) {
    ctx.ui.notify("No active profile. Start Pi with pi-profile first.", "error");
    return;
  }

  const requested = args.trim();
  if (requested === "off" || requested === "disable" || requested === "--off") {
    const targetDir = profileDirForName(targetProfile);
    writeJsonFile(profileSyncConfigPath(targetDir), { enabled: false });
    ctx.ui.notify("Profile sync disabled. Restart Pi to use the updated launch behavior.", "info");
    return;
  }

  const sourceProfile = requested.split(/\s+/)[0] || "default";
  if (sourceProfile !== "default" && !validateProfileName(sourceProfile)) {
    ctx.ui.notify(`Invalid source profile: ${sourceProfile}`, "error");
    return;
  }
  if (sourceProfile === targetProfile) {
    ctx.ui.notify("Cannot sync a profile from itself.", "error");
    return;
  }

  const targetDir = profileDirForName(targetProfile);
  const statePath = profileSyncStatePath(targetDir);
  const existing = readJsonFile<ProfileSyncConfig>(profileSyncConfigPath(targetDir), {});
  const existingState = readJsonFile<NonNullable<ProfileSyncConfig["state"]> & { autoOptOut?: string[] }>(statePath, {});
  const existingExcluded = new Set(existing.from === sourceProfile && Array.isArray(existing.exclude) ? existing.exclude : []);
  const existingAutoOptOut = new Set([
    ...(existing.from === sourceProfile && Array.isArray(existing.autoOptOut) ? existing.autoOptOut : []),
    ...(existing.from === sourceProfile && Array.isArray(existingState.autoOptOut) ? existingState.autoOptOut : []),
  ]);
  const selected = new Set(
    existing.from === sourceProfile && Array.isArray(existing.keys)
      ? existing.keys
      : SYNCABLE_KEYS.filter((key) => !existingExcluded.has(key) && !existingAutoOptOut.has(key)),
  );
  const exclude: string[] = [];
  const enabledKeys: string[] = [];

  for (const key of SYNCABLE_KEYS) {
    const currently = selected.has(key) ? "currently on" : "currently off";
    const enabled = ctx.hasUI
      ? await ctx.ui.confirm(`Sync ${key}?`, `${key} is ${currently}. Enable automatic sync for this key from ${sourceProfile}?`)
      : selected.has(key);
    if (enabled) enabledKeys.push(key);
    else exclude.push(key);
  }

  const targetSettings = readJsonFile<Record<string, unknown>>(join(targetDir, "settings.json"), {});
  const lastSyncedHashes = existingState.lastSyncedHashes && typeof existingState.lastSyncedHashes === "object" ? { ...existingState.lastSyncedHashes } : {};
  const syncedKeys = new Set(Array.isArray(existingState.syncedKeys) ? existingState.syncedKeys : []);
  for (const key of enabledKeys) {
    if (Object.prototype.hasOwnProperty.call(targetSettings, key)) lastSyncedHashes[key] = valueHash(targetSettings[key]);
    syncedKeys.add(key);
  }

  const config: ProfileSyncConfig = {
    enabled: true,
    from: sourceProfile,
    exclude,
    mode: "all-except",
  };
  writeJsonFile(profileSyncConfigPath(targetDir), config);
  writeJsonFile(statePath, {
    autoOptOut: [...existingAutoOptOut].filter((key) => !enabledKeys.includes(key)).sort(),
    lastSyncedHashes,
    syncedKeys: [...syncedKeys].sort(),
  });

  const syncedDescription = exclude.length ? `all non-auth settings except ${exclude.join(", ")}` : "all non-auth settings";
  let message = `Profile sync configured from ${sourceProfile}: ${syncedDescription}.`;
  const applyNow = ctx.hasUI ? await ctx.ui.confirm("Apply now?", "Apply these settings to the current profile now?") : false;
  if (applyNow) {
    const changed = applyProfileSync(targetProfile);
    message += changed.length ? ` Synced now: ${changed.join(", ")}.` : " Nothing changed.";
    if (changed.length > 0 && ctx.hasUI) {
      const reload = await ctx.ui.confirm("Reload runtime?", "Reload extensions, skills, prompts, and themes now?");
      const reloadFn = (ctx as unknown as { reload?: () => Promise<void> }).reload;
      if (reload && typeof reloadFn === "function") {
        await reloadFn.call(ctx);
      }
    }
  } else {
    message += " Restart Pi to apply automatically on launch.";
  }

  ctx.ui.notify(message, "info");
}

export default function authProfileExtension(pi: ExtensionAPI) {
  pi.registerFlag(PROFILE_FLAG, {
    type: "string",
    description: "Name of the auth profile selected by the pi-profile launcher.",
  });

  pi.registerCommand("auth-profile", {
    description: "Show the active Pi auth profile and auth storage location",
    handler: async (_args, ctx) => {
      const info = getProfileInfo(pi);
      ctx.ui.notify(formatInfo(info, ctx), info.mismatch ? "warning" : "info");
    },
  });

  pi.registerCommand("profile-sync", {
    description: "Configure automatic settings sync from another profile on launch",
    getArgumentCompletions: (prefix: string) => {
      const values = ["default", "off", ...listProfiles()];
      return values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      try {
        await configureProfileSync(args, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Profile sync failed: ${message}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const info = getProfileInfo(pi);
    const label = info.profile ?? (info.agentDir ? basename(info.agentDir) : "default");

    if (ctx.hasUI) {
      ctx.ui.setStatus("auth-profile", `auth:${label}`);
      if (info.profile) ctx.ui.setTitle(`pi [${info.profile}]`);
      if (info.mismatch) ctx.ui.notify(info.mismatch, "warning");
    }
  });
}
