import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const PROFILE_FLAG = "auth-profile";
const PROFILE_ENV = "PI_AUTH_PROFILE";
const PROFILE_DIR_ENV = "PI_AUTH_PROFILE_DIR";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
const STRICT_ENV = "PI_AUTH_PROFILE_STRICT_ENV";
const PROFILES_DIR_ENV = "PI_AUTH_PROFILES_DIR";
const DEFAULT_SYNC_KEYS = ["packages", "npmCommand"];
const SYNCABLE_KEYS = ["packages", "npmCommand", "extensions", "skills", "prompts", "themes", "enableSkillCommands"];
const RESOURCE_SYNC_KEYS = new Set(["extensions", "skills", "prompts", "themes"]);

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
  mode?: "replace";
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

function applyProfileSync(targetProfile: string): string[] {
  const targetDir = profileDirForName(targetProfile);
  const config = readJsonFile<ProfileSyncConfig>(profileSyncConfigPath(targetDir), {});
  if (config.enabled === false) return [];

  const sourceProfile = config.from?.trim() || "default";
  const keys = Array.isArray(config.keys) ? config.keys : DEFAULT_SYNC_KEYS;
  const sourceDir = profileDirForName(sourceProfile);
  const sourceSettingsPath = join(sourceDir, "settings.json");
  if (!existsSync(sourceSettingsPath)) return [];

  const sourceSettings = readJsonFile<Record<string, unknown>>(sourceSettingsPath, {});
  const targetSettingsPath = join(targetDir, "settings.json");
  const targetSettings = readJsonFile<Record<string, unknown>>(targetSettingsPath, {});

  const changed: string[] = [];
  for (const key of keys) {
    if (!(key in sourceSettings)) {
      if (key in targetSettings) {
        delete targetSettings[key];
        changed.push(key);
      }
      continue;
    }
    const nextValue = normalizeSyncedValue(key, sourceSettings[key], sourceDir);
    if (JSON.stringify(targetSettings[key]) !== JSON.stringify(nextValue)) {
      targetSettings[key] = nextValue;
      changed.push(key);
    }
  }

  if (changed.length > 0) writeJsonFile(targetSettingsPath, targetSettings);
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
  const config = readJsonFile<ProfileSyncConfig>(profileSyncConfigPath(targetDir), {});
  if (config.enabled === false) return "Profile sync: disabled";
  if (!config.from && !config.keys) return "Profile sync: not configured";
  return `Profile sync: from ${config.from ?? "default"}; keys: ${(Array.isArray(config.keys) ? config.keys : DEFAULT_SYNC_KEYS).join(", ") || "none"}`;
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

  let sourceProfile = requested.split(/\s+/)[0] || undefined;
  if (!sourceProfile && ctx.hasUI) {
    const choices = ["default", ...listProfiles().filter((profile) => profile !== targetProfile)];
    sourceProfile = await ctx.ui.select("Sync settings from profile:", choices);
  }
  sourceProfile = sourceProfile || "default";
  if (sourceProfile !== "default" && !validateProfileName(sourceProfile)) {
    ctx.ui.notify(`Invalid source profile: ${sourceProfile}`, "error");
    return;
  }
  if (sourceProfile === targetProfile) {
    ctx.ui.notify("Cannot sync a profile from itself.", "error");
    return;
  }

  const targetDir = profileDirForName(targetProfile);
  const existing = readJsonFile<ProfileSyncConfig>(profileSyncConfigPath(targetDir), {});
  const selected = new Set(existing.from === sourceProfile && existing.keys ? existing.keys : DEFAULT_SYNC_KEYS);
  const keys: string[] = [];

  for (const key of SYNCABLE_KEYS) {
    const currently = selected.has(key) ? "currently on" : "currently off";
    const enabled = ctx.hasUI
      ? await ctx.ui.confirm(`Sync ${key}?`, `${key} is ${currently}. Enable automatic sync for this key from ${sourceProfile}?`)
      : selected.has(key);
    if (enabled) keys.push(key);
  }

  const config: ProfileSyncConfig = { enabled: true, from: sourceProfile, keys, mode: "replace" };
  writeJsonFile(profileSyncConfigPath(targetDir), config);

  let message = `Profile sync configured from ${sourceProfile}: ${keys.length ? keys.join(", ") : "no keys"}.`;
  if (keys.length > 0) {
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
