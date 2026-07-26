import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  correlateVerifiedReceipt,
  loadJson,
  renderDisabledLaunchAgent,
  renderWorker,
  validateManifest,
} from "./worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = loadJson(join(here, "manifest.json"));
const identityMap = loadJson(join(here, "fixtures", "identity-map.json"));

test("manifest binds external codex_cli identity without changing Aspect semantics", () => {
  const result = validateManifest(manifest, identityMap);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(identityMap.members.codex_cli.gateway_agent_id, null);
  assert.equal(identityMap.members.codex_cli.aspect_slug, null);
});

test("renderer exposes full Buzz CLI credentials only through managed spawn", () => {
  const worker = renderWorker(manifest, identityMap);
  assert.equal(worker.args.includes("--no-agent-publisher-credentials"), false);
  assert.equal(worker.args.includes("--agent-publisher-credentials"), true);
  assert.equal(worker.args.includes("--private-key"), false);
  assert.equal(worker.args.includes("--private-key-file"), true);
  assert.equal(worker.args.includes("--relay-observer"), true);
  assert.equal(worker.environment.BUZZ_PRIVATE_KEY, undefined);
  assert.equal(worker.environment.BUZZ_RELAY_URL, undefined);
});

test("renderer pins one full-access codex-acp subprocess", () => {
  const worker = renderWorker(manifest, identityMap);
  assert.equal(worker.environment.INITIAL_AGENT_MODE, "agent-full-access");
  assert.equal(worker.environment.CODEX_HOME, "/Users/architect/.codex");
  assert.equal(worker.args[worker.args.indexOf("--agents") + 1], "1");
  assert.equal(worker.args[worker.args.indexOf("--permission-mode") + 1], "default");
  assert.equal(worker.args[worker.args.indexOf("--agent-command") + 1], manifest.runtime.codexAcp.binary);
});

test("renderer pins Architect, Nexus, and Mechanon inbound authority", () => {
  const worker = renderWorker(manifest, identityMap);
  const allowlist = worker.args[worker.args.indexOf("--respond-to-allowlist") + 1].split(",");
  assert.deepEqual(allowlist, [
    identityMap.members.nexus.pubkey_hex,
    identityMap.members.mechanon.pubkey_hex,
  ]);
  assert.equal(
    worker.args[worker.args.indexOf("--agent-owner") + 1],
    identityMap.members.architect.pubkey_hex,
  );
});

test("workspace selection is bounded to the manifest allowlist", () => {
  assert.equal(
    renderWorker(manifest, identityMap, "buzz").workingDirectory,
    "/Volumes/AEON/Projects/buzz",
  );
  assert.throws(() => renderWorker(manifest, identityMap, "/tmp/escape"), /not allowed/);
});

test("launchd artifact remains inert and secret-free", () => {
  const artifact = renderDisabledLaunchAgent(manifest, identityMap);
  assert.equal(artifact.runAtLoad, false);
  assert.equal(artifact.keepAlive, false);
  assert.match(artifact.plist, /<key>RunAtLoad<\/key><false\/>/);
  assert.match(artifact.plist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(artifact.plist, /INITIAL_AGENT_MODE<\/key><string>agent-full-access/);
  assert.doesNotMatch(artifact.plist, /BUZZ_PRIVATE_KEY|nsec1/);
  assert.deepEqual(artifact.requiredDirectories, [
    "/Volumes/AEON/runtime/buzz/external-cli/codex_cli/config",
    "/Volumes/AEON/runtime/buzz/external-cli/codex_cli/logs",
  ]);
});

test("verified receipt joins request, session, run, and signed reply", () => {
  const requestEventId = "a".repeat(64);
  const replyEventId = "b".repeat(64);
  const channelId = identityMap.channels.ops.channel_id;
  const result = correlateVerifiedReceipt({
    requestEventId,
    channelId,
    expectedPubkey: identityMap.members.codex_cli.pubkey_hex,
    replyEvent: {
      id: replyEventId,
      pubkey: identityMap.members.codex_cli.pubkey_hex,
      kind: 9,
      verified: true,
      tags: [
        ["h", channelId],
        ["e", requestEventId, "", "reply"],
      ],
    },
    observerRun: {
      requestEventId,
      replyEventId,
      channelId,
      sessionId: "codex-acp-session",
      runId: "buzz-turn-id",
    },
  });
  assert.deepEqual(result, {
    requestEventId,
    replyEventId,
    sessionId: "codex-acp-session",
    runId: "buzz-turn-id",
    channelId,
  });
});

test("receipt correlation rejects unsigned or mismatched replies", () => {
  const requestEventId = "a".repeat(64);
  const channelId = identityMap.channels.ops.channel_id;
  const base = {
    requestEventId,
    channelId,
    expectedPubkey: identityMap.members.codex_cli.pubkey_hex,
    replyEvent: {
      id: "b".repeat(64),
      pubkey: identityMap.members.codex_cli.pubkey_hex,
      kind: 9,
      verified: false,
      tags: [
        ["h", channelId],
        ["e", requestEventId, "", "reply"],
      ],
    },
    observerRun: {
      requestEventId,
      replyEventId: "b".repeat(64),
      channelId,
      sessionId: "session",
      runId: "run",
    },
  };
  assert.throws(() => correlateVerifiedReceipt(base), /signature/);
  base.replyEvent.verified = true;
  base.observerRun.replyEventId = "c".repeat(64);
  assert.throws(() => correlateVerifiedReceipt(base), /correlation/);
});
