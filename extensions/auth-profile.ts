import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const PROFILE_FLAG = "auth-profile";
const PROFILE_ENV = "PI_AUTH_PROFILE";
const PROFILE_DIR_ENV = "PI_AUTH_PROFILE_DIR";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
const STRICT_ENV = "PI_AUTH_PROFILE_STRICT_ENV";

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
  if (info.mismatch) {
    lines.push(`Warning: ${info.mismatch}`);
  }

  return lines.join("\n");
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
