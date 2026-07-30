import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateRemoteSemanticHealth,
  loadJson,
  renderRemoteWorker,
  validateRemoteManifest,
} from "./worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = loadJson(join(here, "workers.json"));
const identityMap = loadJson(join(here, "fixtures", "identity-map.json"));
const runtimeMap = loadJson(join(here, "fixtures", "runtime-map.json"));
const macManifest = loadJson(join(here, "..", "aeon-aspects", "workers.json"));

test("remote manifest adds exactly two Windows seats without changing the Mac six", () => {
  const result = validateRemoteManifest(manifest, identityMap, runtimeMap);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(
    manifest.workers.map(({ aspect }) => aspect).sort(),
    ["fama", "opulentis"],
  );
  assert.equal(macManifest.workers.length, 6);
  assert.deepEqual(
    macManifest.workers.map(({ aspect }) => aspect).sort(),
    ["fontis", "mechanon", "nexus", "sapientis", "viatica", "voxis"],
  );
  assert.deepEqual(manifest.windowsBaseline, {
    fama: {
      gatewayUrl: "ws://127.0.0.1:18821",
      schedulerRoot: "\\FAMA\\",
    },
    opulentis: {
      gatewayUrl: "ws://127.0.0.1:18820",
      schedulerRoot: "\\Opulentis\\",
    },
  });
  assert.deepEqual(manifest.buzz.relayContract, {
    scheme: "wss",
    configured: false,
    liveVerified: false,
  });
});

test("both workers retain memory and the indivisible trusted publisher contract", () => {
  for (const worker of manifest.workers) {
    const rendered = renderRemoteWorker(
      manifest,
      identityMap,
      runtimeMap,
      worker.aspect,
    );
    assert.equal(rendered.enabled, false);
    assert.equal(rendered.activationGate.activationAllowed, false);
    assert.equal(rendered.activationGate.publicSocialMutation, "unknown");
    assert.equal(rendered.activationGate.capitalMutation, "unknown");
    assert.equal(rendered.relayUrl, runtimeMap.relayUrl);
    assert.equal(
      rendered.sessionKey,
      `agent:${identityMap.members[worker.aspect].gateway_agent_id}:buzz-private`,
    );
    assert.equal(rendered.args.includes("--no-memory"), false);
    assert.equal(rendered.args.includes("--trusted-inbound-envelope"), true);
    assert.equal(rendered.args.includes("--no-agent-publisher-credentials"), true);
    assert.equal(rendered.args.includes("--turn-receipts"), true);
    assert.equal(rendered.args.includes("--base-prompt-file"), true);
    assert.equal(
      rendered.args[rendered.args.indexOf("--expected-public-key") + 1],
      identityMap.members[worker.aspect].pubkey_hex,
    );
    assert.equal(
      rendered.args[rendered.args.indexOf("--expected-gateway-session-key") + 1],
      rendered.sessionKey,
    );
    assert.equal(
      rendered.args[rendered.args.indexOf("--permission-mode") + 1],
      "dontAsk",
    );
    assert.doesNotMatch(
      rendered.args.join(" "),
      /--mcp-command|--model|--system-prompt|--team-instructions|--initial-message/,
    );
  }
});

test("remote prompt reuses the shared publisher owner and adds the external-effect boundary", () => {
  for (const worker of manifest.workers) {
    const rendered = renderRemoteWorker(
      manifest,
      identityMap,
      runtimeMap,
      worker.aspect,
    );
    assert.match(rendered.basePrompt, new RegExp(`#aspect-${worker.aspect}`));
    assert.match(
      rendered.basePrompt,
      new RegExp(`exactly one \`buzz_${worker.aspect}_reply\``),
    );
    assert.match(rendered.basePrompt, /Plain assistant text is not published to Buzz/);
    assert.match(rendered.basePrompt, /conversation and read-only inspection only/);
    assert.match(rendered.basePrompt, /Do not publish or edit public\/social content/);
    assert.match(rendered.basePrompt, /do not trade, transfer, place orders/);
    assert.doesNotMatch(rendered.basePrompt, /buzz messages send/);
  }
});

test("fixed private-office configs admit only Architect in the exact room", () => {
  for (const worker of manifest.workers) {
    const rendered = renderRemoteWorker(
      manifest,
      identityMap,
      runtimeMap,
      worker.aspect,
    );
    const channel = identityMap.channels[`aspect_${worker.aspect}`].channel_id;
    assert.match(rendered.config, new RegExp(channel));
    assert.match(rendered.config, /kinds = \[9, 40002\]/);
    assert.match(rendered.config, /require_exact_channel_tag = true/);
    assert.match(rendered.config, /require_mention = false/);
    assert.match(rendered.config, new RegExp(manifest.buzz.architectPubkey));
    assert.doesNotMatch(rendered.config, /admit_invited_ephemeral/);
  }
});

test("Task Scheduler previews are deterministic, disabled, and secret-free", () => {
  for (const worker of manifest.workers) {
    const first = renderRemoteWorker(
      manifest,
      identityMap,
      runtimeMap,
      worker.aspect,
    );
    const second = renderRemoteWorker(
      manifest,
      identityMap,
      runtimeMap,
      worker.aspect,
    );
    assert.deepEqual(second, first);
    assert.match(first.task.xml, /encoding="UTF-8"/);
    assert.match(first.task.xml, /<Enabled>false<\/Enabled>/);
    assert.match(first.task.xml, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(first.task.xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(first.task.xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
    assert.match(first.task.xml, /--private-key-file/);
    assert.match(first.task.xml, /--expected-public-key/);
    assert.doesNotMatch(first.task.xml, /nsec1|BUZZ_PRIVATE_KEY=/);
    assert.deepEqual(first.rollback, [
      "schtasks.exe",
      "/Change",
      "/TN",
      `${manifest.windowsBaseline[worker.aspect].schedulerRoot}AEON-Buzz-${worker.aspect}`,
      "/DISABLE",
    ]);
  }
});

test("Windows argument rendering quotes paths with spaces", () => {
  const withSpaces = structuredClone(runtimeMap);
  withSpaces.workers.fama.buzzAcpPath = "C:\\Program Files\\AEON\\buzz-acp.exe";
  withSpaces.workers.fama.workingDirectory = "C:\\Program Files\\AEON\\FAMA";
  withSpaces.workers.fama.gatewayTokenFile =
    "C:\\Users\\Operator\\Application Data\\AEON\\fama-gateway.token";
  const rendered = renderRemoteWorker(manifest, identityMap, withSpaces, "fama");
  assert.match(
    rendered.task.xml,
    /<Command>C:\\Program Files\\AEON\\buzz-acp\.exe<\/Command>/,
  );
  assert.match(
    rendered.task.xml,
    /<WorkingDirectory>C:\\Program Files\\AEON\\FAMA<\/WorkingDirectory>/,
  );
  assert.match(
    rendered.task.xml,
    /&quot;acp,--session,agent:fama:buzz-private,[^<]*Application Data[^<]*&quot;/,
  );
});

test("source renderer emits two disabled artifacts from synthetic public inputs", () => {
  const output = execFileSync(
    process.execPath,
    [
      join(here, "render-windows-workers.mjs"),
      join(here, "fixtures", "identity-map.json"),
      join(here, "fixtures", "runtime-map.json"),
    ],
    { cwd: here, encoding: "utf8" },
  );
  const rendered = JSON.parse(output);
  assert.equal(rendered.schema, "aeon_buzz_acp_remote_windows_package_v1");
  assert.equal(rendered.enabled, false);
  assert.deepEqual(Object.keys(rendered.workers).sort(), ["fama", "opulentis"]);
});

test("renderer refuses to substitute synthetic defaults for required operator inputs", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, [join(here, "render-windows-workers.mjs")], {
        cwd: here,
        encoding: "utf8",
      }),
    (error) => {
      assert.match(error.stderr, /usage: render-windows-workers/);
      return true;
    },
  );
});

test("validation rejects channel sharing, publisher credentials, and invalid Windows paths", () => {
  const duplicateChannel = structuredClone(identityMap);
  duplicateChannel.channels.aspect_opulentis.channel_id =
    duplicateChannel.channels.aspect_fama.channel_id;
  assert.equal(
    validateRemoteManifest(manifest, duplicateChannel, runtimeMap).ok,
    false,
  );

  const publisherCredentials = structuredClone(manifest);
  publisherCredentials.posture.publisherCredentials = true;
  assert.equal(
    validateRemoteManifest(publisherCredentials, identityMap, runtimeMap).ok,
    false,
  );

  const relativePath = structuredClone(runtimeMap);
  relativePath.workers.fama.gatewayTokenFile = "relative.token";
  assert.equal(
    validateRemoteManifest(manifest, identityMap, relativePath).ok,
    false,
  );

  const missingField = structuredClone(runtimeMap);
  delete missingField.workers.fama.buzzAcpPath;
  assert.equal(
    validateRemoteManifest(manifest, identityMap, missingField).ok,
    false,
  );

  const wrongVerifiedGateway = structuredClone(runtimeMap);
  wrongVerifiedGateway.workers.fama.gatewayUrl = "ws://127.0.0.1:18820";
  assert.equal(
    validateRemoteManifest(manifest, identityMap, wrongVerifiedGateway).ok,
    false,
  );

  const loopbackRelay = structuredClone(runtimeMap);
  loopbackRelay.relayUrl = "wss://127.0.0.1:3000";
  assert.equal(
    validateRemoteManifest(manifest, identityMap, loopbackRelay).ok,
    false,
  );
  for (const relayUrl of [
    "wss://127.0.0.2:3000",
    "wss://[::1]:3000",
    "wss://[::ffff:127.0.0.1]:3000",
  ]) {
    const loopbackAlias = structuredClone(runtimeMap);
    loopbackAlias.relayUrl = relayUrl;
    assert.equal(
      validateRemoteManifest(manifest, identityMap, loopbackAlias).ok,
      false,
      relayUrl,
    );
  }

  const ownerKeyReuse = structuredClone(identityMap);
  ownerKeyReuse.members.fama.pubkey_hex = manifest.buzz.architectPubkey;
  assert.equal(
    validateRemoteManifest(manifest, ownerKeyReuse, runtimeMap).ok,
    false,
  );

  const publisherPathReuse = structuredClone(identityMap);
  publisherPathReuse.members.opulentis.secret_ref =
    publisherPathReuse.members.fama.secret_ref.toUpperCase();
  assert.equal(
    validateRemoteManifest(manifest, publisherPathReuse, runtimeMap).ok,
    false,
  );
});

test("remote semantic health delegates to the existing six-seat owner", () => {
  const result = evaluateRemoteSemanticHealth({
    aspect: "fama",
    sessionKey: "agent:fama:buzz-private",
    state: "running",
    startup: {
      agentPoolReady: true,
      relayConnected: true,
      privateOfficeSubscribed: true,
    },
    receipt: {
      requestEventId: "request",
      replyEventId: "reply",
      replyTo: "request",
      sessionKey: "agent:fama:buzz-private",
      runId: "run",
      toolName: "buzz_fama_reply",
      toolCallCount: 1,
    },
  });
  assert.deepEqual(result, { healthy: true, failures: [] });
});

test("Windows secret contract requires non-reparse owner-only expected-key binding", () => {
  assert.deepEqual(manifest.secretFileContract, {
    absolute: true,
    regular: true,
    reparsePoint: false,
    owner: "current-user-sid",
    daclAllow: ["current-user-sid", "SYSTEM", "Administrators"],
    expectedPublicKey: true,
  });
});

test("readiness collector keeps activation fail-closed on unknown mutation policy", () => {
  const source = fs.readFileSync(join(here, "collect-readiness.ps1"), "utf8");
  const schema = loadJson(join(here, "policy-evidence.schema.json"));
  assert.equal(
    schema.properties.schema.const,
    "aeon_buzz_remote_windows_policy_evidence_v1",
  );
  assert.deepEqual(schema.properties.workers.required, ["fama", "opulentis"]);
  assert.match(source, /public_social_mutation = "unknown"/);
  assert.match(source, /capital_mutation = "unknown"/);
  assert.match(source, /required_mutation_decision = "absent_or_refused"/);
  assert.match(source, /fama = "ws:\/\/127\.0\.0\.1:18821"/);
  assert.match(source, /opulentis = "ws:\/\/127\.0\.0\.1:18820"/);
  assert.match(source, /gateway_baseline_matches = \$gatewayBaselineMatches/);
  assert.match(source, /IPAddress\]::IsLoopback/);
  assert.match(source, /IsIPv4MappedToIPv6/);
  assert.match(source, /runtime_user_sid_matches = \$runtimeSidMatches/);
  assert.match(source, /dacl_present = \$null/);
  assert.match(source, /RawSecurityDescriptor/);
  assert.match(source, /\$result\.dacl_present -and \$unexpected\.Count -eq 0/);
  assert.match(source, /\[ValidateSet\("fama", "opulentis"\)\]/);
  assert.match(source, /policy_review_ready = \$baseReady -and \$policy\.declaration_complete/);
  assert.match(source, /activation_allowed = \$false/);
  assert.match(source, /selected_activation_allowed = \$false/);
  assert.match(source, /if \(-not \$result\.selected_readiness_passed\)/);
  assert.match(source, /exit 2/);
  assert.doesNotMatch(source, /Get-Content[^\\r\\n]*(secret_ref|gatewayTokenFile)/);
});
