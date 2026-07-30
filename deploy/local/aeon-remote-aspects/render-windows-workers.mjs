#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadJson,
  renderRemoteWorker,
  validateRemoteManifest,
} from "./worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = loadJson(join(here, "workers.json"));
if (process.argv.length !== 4) {
  console.error(
    "usage: render-windows-workers.mjs <reviewed-identity-map.json> <reviewed-runtime-map.json>",
  );
  process.exit(1);
}
const identityMap = loadJson(process.argv[2]);
const runtimeMap = loadJson(process.argv[3]);
const validation = validateRemoteManifest(manifest, identityMap, runtimeMap);
if (!validation.ok) {
  console.error(validation.errors.join("\n"));
  process.exit(1);
}
const workers = Object.fromEntries(
  manifest.workers.map(({ aspect }) => [
    aspect,
    renderRemoteWorker(manifest, identityMap, runtimeMap, aspect),
  ]),
);
process.stdout.write(
  `${JSON.stringify(
    {
      schema: "aeon_buzz_acp_remote_windows_package_v1",
      enabled: false,
      workers,
    },
    null,
    2,
  )}\n`,
);
