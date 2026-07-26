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
const claudeManifest = loadJson(join(here, "manifest.claude_cli.json"));
const identityMap = loadJson(join(here, "fixtures", "identity-map.json"));

test("manifest binds external codex_cli identity without changing Aspect semantics", () => {
  const result = validateManifest(manifest, identityMap);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(identityMap.members.codex_cli.gateway_agent_id, null);
  assert.equal(identityMap.members.codex_cli.aspect_slug, null);
});

test("manifest binds a separate external claude_cli identity", () => {
  const result = validateManifest(claudeManifest, identityMap);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(identityMap.members.claude_cli.gateway_agent_id, null);
  assert.equal(identityMap.members.claude_cli.aspect_slug, null);
  assert.notEqual(identityMap.members.claude_cli.pubkey_hex, identityMap.members.codex_cli.pubkey_hex);
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

test("renderer pins one Claude ACP subprocess and installed Claude Code", () => {
  const worker = renderWorker(claudeManifest, identityMap);
  assert.equal(worker.args[worker.args.indexOf("--agents") + 1], "1");
  assert.equal(worker.args[worker.args.indexOf("--permission-mode") + 1], "bypass-permissions");
  assert.equal(worker.args[worker.args.indexOf("--agent-command") + 1], claudeManifest.runtime.claudeAcp.binary);
  assert.equal(worker.environment.CLAUDE_CODE_EXECUTABLE, "/Users/architect/.local/share/claude/versions/2.1.220");
  assert.equal(worker.environment.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(worker.environment.ANTHROPIC_API_KEY, undefined);
});

test("renderer pins Architect, Nexus, and Mechanon inbound authority", () => {
  const worker = renderWorker(manifest, identityMap);
  const allowlist = worker.args[worker.args.indexOf("--respond-to-allowlist") + 1].split(",");
  assert.deepEqual(allowlist, [identityMap.members.nexus.pubkey_hex, identityMap.members.mechanon.pubkey_hex]);
  assert.equal(worker.args[worker.args.indexOf("--agent-owner") + 1], identityMap.members.architect.pubkey_hex);
});

test("workspace selection is bounded to the manifest allowlist", () => {
  assert.equal(renderWorker(manifest, identityMap, "buzz").workingDirectory, "/Volumes/AEON/Projects/buzz");
  assert.throws(() => renderWorker(manifest, identityMap, "/tmp/escape"), /not allowed/);
  assert.equal(renderWorker(claudeManifest, identityMap, "codex").workingDirectory, "/Volumes/AEON/Projects/codex");
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

test("Claude launchd artifact is separate, inert, and secret-free", () => {
  const artifact = renderDisabledLaunchAgent(claudeManifest, identityMap);
  assert.equal(artifact.label, "org.aeon.buzz-acp.claude-cli");
  assert.equal(artifact.runAtLoad, false);
  assert.equal(artifact.keepAlive, false);
  assert.match(artifact.plist, /CLAUDE_CODE_EXECUTABLE/);
  assert.doesNotMatch(artifact.plist, /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CONFIG_DIR|nsec1/);
  assert.deepEqual(artifact.requiredDirectories, [
    "/Volumes/AEON/runtime/buzz/external-cli/claude_cli/config",
    "/Volumes/AEON/runtime/buzz/external-cli/claude_cli/logs",
  ]);
});

test("Claude authority contract rejects missing identity and mode drift", () => {
  const missingIdentity = structuredClone(identityMap);
  delete missingIdentity.members.claude_cli;
  assert.match(
    validateManifest(claudeManifest, missingIdentity).errors.join("\n"),
    /identity map is missing claude_cli/,
  );

  const modeDrift = structuredClone(claudeManifest);
  modeDrift.posture.permissionMode = "default";
  assert.match(validateManifest(modeDrift, identityMap).errors.join("\n"), /must be bypass-permissions/);

  const adapterDrift = structuredClone(claudeManifest);
  adapterDrift.runtime.claudeAcp.integrity = "sha512-ZHJpZnQ=";
  assert.match(validateManifest(adapterDrift, identityMap).errors.join("\n"), /package integrity drift/);

  const configRelocation = structuredClone(claudeManifest);
  configRelocation.runtime.claudeCode.configDir = "/Users/architect/.claude";
  assert.match(
    validateManifest(configRelocation, identityMap).errors.join("\n"),
    /config directory override must be absent/,
  );
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
