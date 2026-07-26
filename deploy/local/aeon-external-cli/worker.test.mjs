import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  correlateVerifiedReceipt,
  hashPackageClosure,
  loadJson,
  renderDisabledLaunchAgent,
  renderWorker,
  validateAmbientAnthropicCredentials,
  validateClaudeSubscriptionAuth,
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

test("claude_cli selector binds the established external claude_code identity", () => {
  const result = validateManifest(claudeManifest, identityMap);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(claudeManifest.worker.selector, "claude_cli");
  assert.equal(claudeManifest.worker.principal, "claude_code");
  assert.equal(identityMap.members.claude_code.gateway_agent_id, null);
  assert.equal(identityMap.members.claude_code.aspect_slug, null);
  assert.notEqual(identityMap.members.claude_code.pubkey_hex, identityMap.members.codex_cli.pubkey_hex);
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
  assert.equal(worker.command, "/usr/bin/env");
  assert.deepEqual(worker.args.slice(0, 5), [
    "-u",
    "ANTHROPIC_API_KEY",
    "-u",
    "ANTHROPIC_AUTH_TOKEN",
    claudeManifest.runtime.buzzAcpBinary,
  ]);
  assert.equal(worker.args.includes("--agent-publisher-credentials"), false);
  assert.equal(worker.args.includes("--no-agent-publisher-credentials"), false);
  assert.equal(
    worker.args[worker.args.indexOf("--agent-command") + 1],
    "/Users/architect/Library/Application Support/AEON/aeon-v6/claude-acp/0.62.0/node_modules/.bin/claude-agent-acp",
  );
  assert.equal(worker.args[worker.args.indexOf("--agents") + 1], "1");
  assert.equal(worker.args[worker.args.indexOf("--permission-mode") + 1], "bypass-permissions");
  assert.equal(worker.args[worker.args.indexOf("--agent-command") + 1], claudeManifest.runtime.claudeAcp.binary);
  assert.equal(
    worker.signerFile,
    "/Users/architect/Library/Application Support/AEON/aeon-v6/secrets/claude-code.sk",
  );
  assert.equal(worker.expectedPublicKey, identityMap.members.claude_code.pubkey_hex);
  assert.equal(worker.environment.CLAUDE_CODE_EXECUTABLE, "/Users/architect/.local/share/claude/versions/2.1.220");
  assert.equal(worker.environment.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(worker.environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(worker.environment.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("Claude rendered command scrubs ambient API credentials from its child", () => {
  const worker = renderWorker(claudeManifest, identityMap);
  const buzzBinaryIndex = worker.args.indexOf(claudeManifest.runtime.buzzAcpBinary);
  const probe = spawnSync(
    worker.command,
    [
      ...worker.args.slice(0, buzzBinaryIndex),
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify({key:process.env.ANTHROPIC_API_KEY,token:process.env.ANTHROPIC_AUTH_TOKEN}))",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "ambient-key",
        ANTHROPIC_AUTH_TOKEN: "ambient-token",
      },
    },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), {});
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
  assert.match(artifact.plist, /<string>-u<\/string>\s+<string>ANTHROPIC_API_KEY<\/string>/);
  assert.match(artifact.plist, /<string>-u<\/string>\s+<string>ANTHROPIC_AUTH_TOKEN<\/string>/);
  assert.doesNotMatch(artifact.plist, /<key>ANTHROPIC_API_KEY|<key>ANTHROPIC_AUTH_TOKEN|CLAUDE_CONFIG_DIR|nsec1|sk-ant-/);
  assert.deepEqual(artifact.requiredDirectories, [
    "/Users/architect/Library/Application Support/AEON/aeon-v6/buzz",
    "/Users/architect/Library/Application Support/AEON/aeon-v6/logs",
    "/Users/architect/Library/Application Support/AEON/aeon-v6/secrets",
  ]);
  assert.match(
    artifact.plist,
    /\/Users\/architect\/Library\/Application Support\/AEON\/aeon-v6\/bin\/buzz-acp/,
  );
  assert.doesNotMatch(artifact.plist, /buzz-acp-claude-cli/);
  assert.doesNotMatch(artifact.plist, /\/Volumes\/AEON\/runtime\/buzz\/external-cli\/claude_cli/);
  assert.match(
    artifact.plist,
    /\/Users\/architect\/Library\/Application Support\/AEON\/aeon-v6\/secrets\/claude-code\.sk/,
  );
  assert.doesNotMatch(artifact.plist, /\/Volumes\/AEON\/Projects\/buzz-data\/keys\/claude_code\.sk/);
});

test("Claude authority contract rejects missing identity and mode drift", () => {
  const missingIdentity = structuredClone(identityMap);
  delete missingIdentity.members.claude_code;
  assert.match(
    validateManifest(claudeManifest, missingIdentity).errors.join("\n"),
    /identity map is missing claude_code/,
  );

  const duplicateIdentity = structuredClone(claudeManifest);
  duplicateIdentity.worker.principal = "claude_cli";
  assert.match(
    validateManifest(duplicateIdentity, identityMap).errors.join("\n"),
    /must bind to claude_code/,
  );

  const modeDrift = structuredClone(claudeManifest);
  modeDrift.posture.permissionMode = "default";
  assert.match(validateManifest(modeDrift, identityMap).errors.join("\n"), /must be bypass-permissions/);

  const adapterDrift = structuredClone(claudeManifest);
  adapterDrift.runtime.claudeAcp.integrity = "sha512-ZHJpZnQ=";
  assert.match(validateManifest(adapterDrift, identityMap).errors.join("\n"), /package integrity drift/);

  const closureDrift = structuredClone(claudeManifest);
  closureDrift.runtime.claudeAcp.closureSha256 = "0".repeat(64);
  assert.match(validateManifest(closureDrift, identityMap).errors.join("\n"), /package closure checkpoint drift/);

  const configRelocation = structuredClone(claudeManifest);
  configRelocation.runtime.claudeCode.configDir = "/Users/architect/.claude";
  assert.match(
    validateManifest(configRelocation, identityMap).errors.join("\n"),
    /config directory override must be absent/,
  );

  const volumeRuntime = structuredClone(claudeManifest);
  volumeRuntime.runtime.buzzAcpBinary = "/Volumes/AEON/runtime/buzz-acp";
  assert.match(validateManifest(volumeRuntime, identityMap).errors.join("\n"), /launchd-safe Data-volume path/);

  const sharedHarnessDrift = structuredClone(claudeManifest);
  sharedHarnessDrift.runtime.buzzAcpSha256 = "0".repeat(64);
  assert.match(validateManifest(sharedHarnessDrift, identityMap).errors.join("\n"), /shared buzz-acp checkpoint drift/);

  const signerDrift = structuredClone(claudeManifest);
  signerDrift.runtime.signerPath = identityMap.members.claude_code.secret_ref;
  assert.match(validateManifest(signerDrift, identityMap).errors.join("\n"), /launchd-safe Data-volume path/);
});

test("Claude package closure digest detects adapter and dependency changes", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-agent-acp-closure-"));
  try {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.js"), "entrypoint\n");
    const sibling = join(root, "dist", "acp-agent.js");
    writeFileSync(sibling, "original sibling\n");
    mkdirSync(join(root, "node_modules", "dependency"), { recursive: true });
    const dependency = join(root, "node_modules", "dependency", "index.js");
    writeFileSync(dependency, "original dependency\n");

    const initial = hashPackageClosure(root);
    assert.equal(hashPackageClosure(root), initial);
    writeFileSync(sibling, "modified sibling\n");
    const siblingChanged = hashPackageClosure(root);
    assert.notEqual(siblingChanged, initial);
    writeFileSync(sibling, "original sibling\n");
    writeFileSync(dependency, "modified dependency\n");
    assert.notEqual(hashPackageClosure(root), initial);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude runtime auth requires the pinned subscription provider and type", () => {
  const contract = claudeManifest.runtime.claudeCode.auth;
  const valid = {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "pro",
  };
  assert.deepEqual(validateClaudeSubscriptionAuth(valid, contract), { ok: true, errors: [] });

  const wrongMethod = validateClaudeSubscriptionAuth({ ...valid, authMethod: "apiKey" }, contract);
  assert.equal(wrongMethod.ok, false);
  assert.match(wrongMethod.errors.join("\n"), /auth method/);

  const wrongProvider = validateClaudeSubscriptionAuth({ ...valid, apiProvider: "bedrock" }, contract);
  assert.equal(wrongProvider.ok, false);
  assert.match(wrongProvider.errors.join("\n"), /API provider/);

  const wrongSubscription = validateClaudeSubscriptionAuth({ ...valid, subscriptionType: "free" }, contract);
  assert.equal(wrongSubscription.ok, false);
  assert.match(wrongSubscription.errors.join("\n"), /subscription type/);
});

test("Claude runtime rejects ambient API credentials without exposing values", () => {
  assert.deepEqual(validateAmbientAnthropicCredentials({}), { ok: true, errors: [] });
  const result = validateAmbientAnthropicCredentials({
    ANTHROPIC_API_KEY: "secret-api-key",
    ANTHROPIC_AUTH_TOKEN: "secret-auth-token",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "ANTHROPIC_API_KEY must be absent for Claude subscription authentication",
    "ANTHROPIC_AUTH_TOKEN must be absent for Claude subscription authentication",
  ]);
  assert.doesNotMatch(result.errors.join("\n"), /secret-/);
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
