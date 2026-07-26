#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, renderDisabledLaunchAgent, validateManifest } from "./worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceArg = process.argv.indexOf("--workspace");
const workspace = workspaceArg >= 0 ? process.argv[workspaceArg + 1] : undefined;
const identityArg = process.argv.indexOf("--identity-map");
const identityPath =
  identityArg >= 0 ? process.argv[identityArg + 1] : join(here, "fixtures", "identity-map.json");
const manifest = loadJson(join(here, "manifest.json"));
const identityMap = loadJson(identityPath);
const validation = validateManifest(manifest, identityMap);
if (!validation.ok) {
  console.error(validation.errors.join("\n"));
  process.exit(1);
}

process.stdout.write(renderDisabledLaunchAgent(manifest, identityMap, workspace).plist);
