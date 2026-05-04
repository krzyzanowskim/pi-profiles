#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KNOWN_AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_GATEWAY_ID",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "HF_TOKEN",
  "HUGGINGFACE_API_KEY",
  "FIREWORKS_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "XIAOMI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
];

function usage() {
  console.log(`pi-profile - run Pi with an isolated auth profile

Usage:
  pi-profile <profile> [pi args...]
  pi-profile --list
  pi-profile --dir <profile>
  pi-profile --shell [profile...]

pi-profile options:
  --allow-env-auth             Preserve shell API-key environment variables

Examples:
  pi-profile personal
  pi-profile work --model claude-sonnet-4-5
  pi-profile work -p "Summarize this repo"
  pi-profile --shell work personal >> ~/.zshrc

Profiles live in:
  ${profilesBaseDir()}/<profile>

By default, auth/settings/models/resources are profile-specific, while sessions
are shared automatically in:
  ${sharedSessionsDir()}

The wrapper also clears common provider API-key environment variables by default.
Put profile-specific environment variables in <profile>/env, or pass
--allow-env-auth to preserve the current shell environment.`);
}

function profilesBaseDir() {
  return resolve(expandHome(process.env.PI_AUTH_PROFILES_DIR || "~/.pi/agent-profiles"));
}

function sharedSessionsDir() {
  return resolve(expandHome("~/.pi/agent/sessions"));
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function fail(message) {
  console.error(`pi-profile: ${message}`);
  process.exit(1);
}

function validateProfileName(profile) {
  if (!/^[A-Za-z0-9._-]+$/.test(profile) || profile === "." || profile === "..") {
    fail(`invalid profile name "${profile}". Use letters, numbers, dot, underscore, or dash.`);
  }
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function listProfiles() {
  const base = profilesBaseDir();
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellFunctionName(profile) {
  return `pi_${profile.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function printShellIntegration(profiles) {
  if (profiles.length === 0) {
    console.log(`# No profiles found in ${profilesBaseDir()}.
# Pass names explicitly, for example:
#   pi-profile --shell work personal >> ~/.zshrc`);
    return;
  }

  const usedNames = new Map();
  for (const profile of profiles) {
    validateProfileName(profile);
    const name = shellFunctionName(profile);
    const existing = usedNames.get(name);
    if (existing) {
      fail(`profiles "${existing}" and "${profile}" both map to shell function "${name}"`);
    }
    usedNames.set(name, profile);
  }

  console.log(`# pi-profile shell shortcuts
# Add this to ~/.zshrc, ~/.bashrc, or another shell startup file.`);
  for (const profile of profiles) {
    console.log(`
${shellFunctionName(profile)}() {
  pi-profile ${shellQuote(profile)} "$@"
}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage();
    return;
  }

  if (argv[0] === "--list") {
    const profiles = listProfiles();
    console.log(profiles.length ? profiles.join("\n") : "(no profiles)");
    return;
  }

  if (argv[0] === "--dir") {
    const profile = argv[1];
    if (!profile) fail("--dir requires a profile name");
    validateProfileName(profile);
    console.log(join(profilesBaseDir(), profile));
    return;
  }

  if (argv[0] === "--shell") {
    printShellIntegration(argv.slice(1).length ? argv.slice(1) : listProfiles());
    return;
  }

  const profile = argv.shift();
  validateProfileName(profile);

  let allowEnvAuth = false;
  let hasExplicitPiSessionDir = false;
  const piArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allow-env-auth") {
      allowEnvAuth = true;
      continue;
    }
    if (arg === "--session-dir" || arg.startsWith("--session-dir=")) {
      hasExplicitPiSessionDir = true;
    }
    if (arg === "--") {
      piArgs.push(...argv.slice(i + 1));
      break;
    }
    piArgs.push(arg);
  }

  const profileDir = join(profilesBaseDir(), profile);
  mkdirSync(profileDir, { recursive: true });

  const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/auth-profile.ts");
  const env = { ...process.env };

  if (!allowEnvAuth) {
    for (const key of KNOWN_AUTH_ENV) delete env[key];
    env.PI_AUTH_PROFILE_STRICT_ENV = "1";
  } else {
    env.PI_AUTH_PROFILE_STRICT_ENV = "0";
  }

  Object.assign(env, parseEnvFile(join(profileDir, "env")));
  env.PI_AUTH_PROFILE = profile;
  env.PI_AUTH_PROFILE_DIR = profileDir;
  env.PI_CODING_AGENT_DIR = profileDir;

  if (!hasExplicitPiSessionDir) {
    const sessionDir = sharedSessionsDir();
    mkdirSync(sessionDir, { recursive: true });
    env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  }

  const piBinary = process.env.PI_BINARY || "pi";
  const child = spawn(piBinary, ["--auth-profile", profile, "--extension", extensionPath, ...piArgs], {
    stdio: "inherit",
    env,
  });

  child.on("error", (error) => {
    fail(`failed to start ${piBinary}: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
