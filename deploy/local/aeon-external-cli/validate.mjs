#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashPackageClosure,
  loadJson,
  renderDisabledLaunchAgent,
  validateAmbientAnthropicCredentials,
  validateClaudeSubscriptionAuth,
  validateManifest,
} from "./worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const optionValues = new Set([option("--worker")].filter(Boolean));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--") && !optionValues.has(arg));
const identityPath = positional[0] ?? join(here, "fixtures", "identity-map.json");
const worker = option("--worker") ?? "codex_cli";
if (!["codex_cli", "claude_cli"].includes(worker)) {
  console.error(`unsupported external CLI worker: ${worker}`);
  process.exit(1);
}
const manifestName = worker === "codex_cli" ? "manifest.json" : `manifest.${worker}.json`;
const manifest = loadJson(join(here, manifestName));
const identityMap = loadJson(identityPath);
const validation = validateManifest(manifest, identityMap);
if (!validation.ok) {
  console.error(validation.errors.join("\n"));
  process.exit(1);
}

const selector = manifest.worker.selector ?? manifest.worker.principal;
const configText = fs.readFileSync(join(here, "config", `${selector}.toml`), "utf8");
const expectedRooms = [...manifest.buzz.sharedRooms, ...manifest.buzz.officeRooms].map(
  (roomName) => identityMap.channels[roomName].channel_id,
);
for (const roomId of expectedRooms) {
  if (configText.split(roomId).length !== 2) {
    console.error(`subscription config must contain room exactly once: ${roomId}`);
    process.exit(1);
  }
}
if ((configText.match(/require_mention = true/g) ?? []).length !== 2) {
  console.error("every external CLI subscription rule must require a mention");
  process.exit(1);
}

const artifact = renderDisabledLaunchAgent(manifest, identityMap);
if (artifact.plist.includes("BUZZ_PRIVATE_KEY") || artifact.plist.includes("nsec1")) {
  console.error("rendered artifact contains signer material");
  process.exit(1);
}
if (artifact.args.includes("--no-agent-publisher-credentials")) {
  console.error(`external ${manifest.worker.principal} must receive its own managed Buzz credentials`);
  process.exit(1);
}
if (!artifact.args.includes("--agent-publisher-credentials")) {
  console.error(`external ${manifest.worker.principal} must explicitly opt into managed Buzz credentials`);
  process.exit(1);
}

const runtimeCheck = process.argv.includes("--runtime");
if (runtimeCheck) {
  const adapter = selector === "codex_cli" ? manifest.runtime.codexAcp : manifest.runtime.claudeAcp;
  for (const binary of [manifest.runtime.buzzAcpBinary, adapter.binary]) {
    fs.accessSync(binary, fs.constants.X_OK);
  }
  for (const directory of artifact.requiredDirectories) {
    if (!fs.statSync(directory).isDirectory()) {
      throw new Error(`required runtime path is not a directory: ${directory}`);
    }
  }
  const nodeBinary = manifest.runtime.path
    .map((directory) => join(directory, "node"))
    .find((candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!nodeBinary) {
    throw new Error("rendered PATH does not contain an executable Node runtime");
  }
  const adapterEntrypoint = fs.realpathSync(adapter.binary);
  const adapterSha256 = createHash("sha256").update(fs.readFileSync(adapterEntrypoint)).digest("hex");
  if (adapterSha256 !== adapter.entrypointSha256) {
    throw new Error(`${manifest.worker.principal} ACP entrypoint SHA-256 does not match the manifest pin`);
  }
  if (selector === "codex_cli") {
    fs.accessSync(manifest.runtime.codexHome, fs.constants.R_OK);
    const adapterVersion = spawnSync(adapter.binary, ["--version"], {
      encoding: "utf8",
      env: artifact.environment,
    });
    if (adapterVersion.status !== 0) {
      throw new Error(`codex-acp --version failed: ${adapterVersion.stderr.trim()}`);
    }
    if (!adapterVersion.stdout.includes(` ${adapter.version}`)) {
      throw new Error(`codex-acp version does not match ${adapter.version}`);
    }
  } else {
    const packageRoot = dirname(dirname(adapterEntrypoint));
    const packageJson = loadJson(join(packageRoot, "package.json"));
    if (packageJson.name !== adapter.package || packageJson.version !== adapter.version) {
      throw new Error("claude-agent-acp package metadata does not match the manifest pin");
    }
    if (hashPackageClosure(adapter.root) !== adapter.closureSha256) {
      throw new Error("claude-agent-acp installed package closure does not match the manifest pin");
    }
    const adapterVersion = spawnSync(adapter.binary, ["--version"], {
      encoding: "utf8",
      env: artifact.environment,
    });
    if (adapterVersion.status !== 0 || adapterVersion.stdout.trim() !== adapter.version) {
      throw new Error(`claude-agent-acp version does not match ${adapter.version}`);
    }
    fs.accessSync(manifest.runtime.claudeCode.binary, fs.constants.X_OK);
    const claudeSha256 = createHash("sha256").update(fs.readFileSync(manifest.runtime.claudeCode.binary)).digest("hex");
    if (claudeSha256 !== manifest.runtime.claudeCode.binarySha256) {
      throw new Error("Claude Code binary SHA-256 does not match the manifest pin");
    }
    const ambientCredentials = validateAmbientAnthropicCredentials(process.env);
    if (!ambientCredentials.ok) {
      throw new Error(ambientCredentials.errors.join("\n"));
    }
    const standardClaudeEnvironment = { ...process.env, ...artifact.environment };
    delete standardClaudeEnvironment.CLAUDE_CONFIG_DIR;
    delete standardClaudeEnvironment.ANTHROPIC_API_KEY;
    delete standardClaudeEnvironment.ANTHROPIC_AUTH_TOKEN;
    const claudeVersion = spawnSync(manifest.runtime.claudeCode.binary, ["--version"], {
      encoding: "utf8",
      env: standardClaudeEnvironment,
    });
    if (claudeVersion.status !== 0 || !claudeVersion.stdout.startsWith(manifest.runtime.claudeCode.version)) {
      throw new Error(`Claude Code version does not match ${manifest.runtime.claudeCode.version}`);
    }
    const authStatus = spawnSync(manifest.runtime.claudeCode.binary, ["auth", "status"], {
      encoding: "utf8",
      env: standardClaudeEnvironment,
    });
    let auth;
    try {
      auth = JSON.parse(authStatus.stdout);
    } catch {
      throw new Error("Claude Code auth status did not return JSON");
    }
    if (authStatus.status !== 0) {
      throw new Error("Claude Code auth status failed");
    }
    const authValidation = validateClaudeSubscriptionAuth(auth, manifest.runtime.claudeCode.auth);
    if (!authValidation.ok) {
      throw new Error(authValidation.errors.join("\n"));
    }
  }
}

const result = {
  ok: true,
  enabled: false,
  principal: manifest.worker.principal,
  ...(selector !== manifest.worker.principal ? { worker: selector } : {}),
  workspace: artifact.workingDirectory,
  ...(selector === "codex_cli"
    ? { agentMode: artifact.environment.INITIAL_AGENT_MODE }
    : { permissionMode: manifest.posture.permissionMode }),
  runtimeCheck,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
