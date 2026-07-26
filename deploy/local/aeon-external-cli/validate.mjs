#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, renderDisabledLaunchAgent, validateManifest } from "./worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const identityPath = positional[0] ?? join(here, "fixtures", "identity-map.json");
const manifest = loadJson(join(here, "manifest.json"));
const identityMap = loadJson(identityPath);
const validation = validateManifest(manifest, identityMap);
if (!validation.ok) {
  console.error(validation.errors.join("\n"));
  process.exit(1);
}

const configText = fs.readFileSync(join(here, "config", "codex_cli.toml"), "utf8");
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
  console.error("external codex_cli must receive its own managed Buzz credentials");
  process.exit(1);
}
if (!artifact.args.includes("--agent-publisher-credentials")) {
  console.error("external codex_cli must explicitly opt into managed Buzz credentials");
  process.exit(1);
}

const runtimeCheck = process.argv.includes("--runtime");
if (runtimeCheck) {
  for (const binary of [manifest.runtime.buzzAcpBinary, manifest.runtime.codexAcp.binary]) {
    fs.accessSync(binary, fs.constants.X_OK);
  }
  fs.accessSync(manifest.runtime.codexHome, fs.constants.R_OK);
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
  const adapterVersion = spawnSync(manifest.runtime.codexAcp.binary, ["--version"], {
    encoding: "utf8",
    env: artifact.environment,
  });
  if (adapterVersion.status !== 0) {
    throw new Error(`codex-acp --version failed: ${adapterVersion.stderr.trim()}`);
  }
  if (!adapterVersion.stdout.includes(` ${manifest.runtime.codexAcp.version}`)) {
    throw new Error(`codex-acp version does not match ${manifest.runtime.codexAcp.version}`);
  }
  const adapterEntrypoint = fs.realpathSync(manifest.runtime.codexAcp.binary);
  const adapterSha256 = createHash("sha256")
    .update(fs.readFileSync(adapterEntrypoint))
    .digest("hex");
  if (adapterSha256 !== manifest.runtime.codexAcp.entrypointSha256) {
    throw new Error("codex-acp entrypoint SHA-256 does not match the manifest pin");
  }
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    enabled: false,
    principal: manifest.worker.principal,
    workspace: artifact.workingDirectory,
    agentMode: artifact.environment.INITIAL_AGENT_MODE,
    runtimeCheck,
  })}\n`,
);
