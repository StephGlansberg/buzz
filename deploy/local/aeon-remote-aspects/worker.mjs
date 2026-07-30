import fs from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTrustedPublisherContract,
  evaluateSemanticHealth,
  renderPrivateOfficePrompt,
} from "../aeon-aspects/worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sharedPromptTemplatePath = join(
  here,
  "..",
  "aeon-aspects",
  "prompts",
  "private-office.template.md",
);
const configTemplatePath = join(here, "config", "private-office.toml.template");
const WINDOWS_PATH = /^[A-Za-z]:\\[^,\0\r\n]+$/;
const PUBKEY = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SID = /^S-\d+(?:-\d+)+$/;
const REQUIRED_RUNTIME_FIELDS = [
  "buzzAcpPath",
  "openclawPath",
  "workingDirectory",
  "gatewayUrl",
  "gatewayTokenFile",
  "configPath",
  "basePromptPath",
];

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) return host.split(".", 1)[0] === "127";
  // URL normalizes IPv4-mapped IPv6 to hexadecimal. Reject the mapped
  // family rather than risk accepting a loopback alias as a remote relay.
  return isIP(host) === 6 && host.startsWith("::ffff:");
}

export function loadJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function exactWorkerSlugs(manifest) {
  return manifest.workers?.map(({ aspect }) => aspect).sort();
}

export function validateRemoteManifest(manifest, identityMap, runtimeMap) {
  const errors = [];
  if (manifest.schema !== "aeon_buzz_acp_remote_windows_workers_v1") {
    errors.push("unexpected remote worker schema");
  }
  if (manifest.enabled !== false || manifest.supervisor?.enabled !== false) {
    errors.push("source package and scheduled tasks must be disabled");
  }
  if (JSON.stringify(exactWorkerSlugs(manifest)) !== JSON.stringify(["fama", "opulentis"])) {
    errors.push("remote package must contain exactly FAMA and Opulentis");
  }
  if (
    manifest.buzz?.relayContract?.scheme !== "wss" ||
    manifest.buzz?.relayContract?.configured !== false ||
    manifest.buzz?.relayContract?.liveVerified !== false
  ) {
    errors.push("remote relay must remain an unconfigured, unverified WSS contract");
  }
  let relayUrl;
  try {
    relayUrl = new URL(runtimeMap.relayUrl);
  } catch {
    errors.push("runtimeMap.relayUrl must be an explicit reviewed WSS URL");
  }
  if (
    relayUrl &&
    (relayUrl.protocol !== "wss:" ||
      relayUrl.username !== "" ||
      relayUrl.password !== "" ||
      relayUrl.pathname !== "/" ||
      relayUrl.search !== "" ||
      relayUrl.hash !== "" ||
      isLoopbackHost(relayUrl.hostname))
  ) {
    errors.push("runtimeMap.relayUrl must be a credential-free non-loopback WSS origin");
  }
  if (!PUBKEY.test(manifest.buzz?.architectPubkey ?? "")) {
    errors.push("Architect pubkey must be lowercase 64-hex");
  }
  const posture = manifest.posture ?? {};
  for (const [field, expected] of Object.entries({
    agents: 1,
    respondTo: "owner-only",
    memory: true,
    customBasePrompt: true,
    dedup: "queue",
    multipleEventHandling: "queue",
    relayObserver: true,
    trustedInboundEnvelope: true,
    publisherCredentials: false,
    turnReceipts: true,
    externalMutationAuthority: false,
  })) {
    if (posture[field] !== expected) errors.push(`posture.${field} must be ${expected}`);
  }
  if (posture.allowedRespondTo?.length !== 1 || posture.allowedRespondTo[0] !== "owner-only") {
    errors.push("allowedRespondTo must remain owner-only");
  }
  if (posture.permissionMode !== "dontAsk") {
    errors.push("remote conversation seats must fail closed on permission prompts");
  }
  const secretContract = manifest.secretFileContract ?? {};
  if (
    secretContract.absolute !== true ||
    secretContract.regular !== true ||
    secretContract.reparsePoint !== false ||
    secretContract.owner !== "current-user-sid" ||
    secretContract.expectedPublicKey !== true ||
    JSON.stringify(secretContract.daclAllow) !==
      JSON.stringify(["current-user-sid", "SYSTEM", "Administrators"])
  ) {
    errors.push("Windows secret-file contract drift");
  }
  const activationGate = manifest.activationGate ?? {};
  if (
    activationGate.activationAllowed !== false ||
    activationGate.publicSocialMutation !== "unknown" ||
    activationGate.capitalMutation !== "unknown" ||
    activationGate.requiredEvidenceSchema !==
      "aeon_buzz_remote_windows_policy_evidence_v1" ||
    activationGate.requiredDecision !== "absent_or_refused"
  ) {
    errors.push("remote activation must remain blocked on explicit mutation-policy evidence");
  }
  if (!SID.test(runtimeMap.windowsUserSid ?? "")) {
    errors.push("runtimeMap.windowsUserSid must be an explicit Windows SID");
  }
  if (identityMap.members?.architect?.pubkey_hex !== manifest.buzz?.architectPubkey) {
    errors.push("Architect identity-map pubkey drift");
  }

  const seenChannels = new Set();
  const seenPubkeys = new Set();
  const seenPublisherKeyPaths = new Set();
  for (const worker of manifest.workers ?? []) {
    const baseline = manifest.windowsBaseline?.[worker.aspect];
    const member = identityMap.members?.[worker.aspect];
    const channel = identityMap.channels?.[`aspect_${worker.aspect}`];
    const runtime = runtimeMap.workers?.[worker.aspect];
    if (!member) {
      errors.push(`${worker.aspect}: missing identity-map member`);
      continue;
    }
    if (!channel) errors.push(`${worker.aspect}: missing private-office channel`);
    if (!runtime) errors.push(`${worker.aspect}: missing Windows runtime map`);
    if (
      baseline?.gatewayUrl !==
        (worker.aspect === "fama"
          ? "ws://127.0.0.1:18821"
          : "ws://127.0.0.1:18820") ||
      baseline?.schedulerRoot !==
        (worker.aspect === "fama" ? "\\FAMA\\" : "\\Opulentis\\")
    ) {
      errors.push(`${worker.aspect}: verified Windows baseline drift`);
    }
    if (member.display_name !== worker.displayName) {
      errors.push(`${worker.aspect}: display-name drift`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(member.gateway_agent_id ?? "")) {
      errors.push(`${worker.aspect}: missing or invalid reviewed Gateway agent id`);
    }
    if (member.session_key !== `agent:${member.gateway_agent_id}:buzz-private`) {
      errors.push(`${worker.aspect}: fixed private session drift`);
    }
    if (!PUBKEY.test(member.pubkey_hex ?? "")) {
      errors.push(`${worker.aspect}: Buzz pubkey must be lowercase 64-hex`);
    } else if (member.pubkey_hex === manifest.buzz.architectPubkey) {
      errors.push(`${worker.aspect}: Buzz pubkey must differ from the Architect owner`);
    } else if (seenPubkeys.has(member.pubkey_hex)) {
      errors.push(`${worker.aspect}: duplicate Buzz pubkey`);
    } else {
      seenPubkeys.add(member.pubkey_hex);
    }
    if (!WINDOWS_PATH.test(member.secret_ref ?? "")) {
      errors.push(`${worker.aspect}: private-key path must be absolute Windows path`);
    } else {
      const keyPath = member.secret_ref.toLocaleLowerCase("en-US");
      if (seenPublisherKeyPaths.has(keyPath)) {
        errors.push(`${worker.aspect}: Buzz publisher key path must be unique`);
      }
      seenPublisherKeyPaths.add(keyPath);
    }
    if (!UUID.test(channel?.channel_id ?? "")) {
      errors.push(`${worker.aspect}: private channel must be a UUID`);
    } else if (seenChannels.has(channel.channel_id)) {
      errors.push(`${worker.aspect}: duplicate private channel`);
    } else {
      seenChannels.add(channel.channel_id);
    }
    if (JSON.stringify(channel?.members) !== JSON.stringify(["architect", worker.aspect])) {
      errors.push(`${worker.aspect}: private channel membership must be exact`);
    }
    for (const field of REQUIRED_RUNTIME_FIELDS) {
      const value = runtime?.[field];
      if (
        field === "gatewayUrl"
          ? !/^wss?:\/\/127\.0\.0\.1:\d+$/.test(value)
          : !WINDOWS_PATH.test(value)
      ) {
        errors.push(`${worker.aspect}: invalid runtime path/URL ${field}`);
      }
    }
    if (runtime?.gatewayUrl !== baseline?.gatewayUrl) {
      errors.push(`${worker.aspect}: Gateway URL differs from verified Windows baseline`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function renderConfig(aspect, channelId, architectPubkey) {
  return fs
    .readFileSync(configTemplatePath, "utf8")
    .replaceAll("{{ASPECT}}", aspect)
    .replaceAll("{{PRIVATE_CHANNEL_ID}}", channelId)
    .replaceAll("{{ARCHITECT_PUBKEY}}", architectPubkey);
}

function renderPrompt(aspect) {
  const shared = renderPrivateOfficePrompt(
    fs.readFileSync(sharedPromptTemplatePath, "utf8"),
    aspect,
  );
  return `${shared}

## Remote effect boundary

This private office authorizes conversation and read-only inspection only. Do not publish or edit public/social content, and do not trade, transfer, place orders, or change capital positions. A separate explicit job and approval contract is required for any such effect. This boundary does not block read-only research, recall, planning, or status work.
`;
}

function quoteWindowsArgument(value) {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  return `"${value
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1")}"`;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderTaskXml(manifest, runtimeMap, aspect, command, args) {
  const taskName = `${manifest.windowsBaseline[aspect].schedulerRoot}AEON-Buzz-${aspect}`;
  const argumentsLine = args.map(quoteWindowsArgument).join(" ");
  return {
    taskName,
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Disabled AEON ${xml(aspect)} Buzz private-office worker</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(runtimeMap.windowsUserSid)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(runtimeMap.windowsUserSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>${xml(manifest.supervisor.multipleInstances)}</MultipleInstancesPolicy>
    <RestartOnFailure><Interval>${xml(manifest.supervisor.restartInterval)}</Interval><Count>${manifest.supervisor.restartCount}</Count></RestartOnFailure>
    <Enabled>false</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(command)}</Command><Arguments>${xml(argumentsLine)}</Arguments><WorkingDirectory>${xml(runtimeMap.workers[aspect].workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>
`,
  };
}

export function renderRemoteWorker(manifest, identityMap, runtimeMap, aspect) {
  const validation = validateRemoteManifest(manifest, identityMap, runtimeMap);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));
  const worker = manifest.workers.find((candidate) => candidate.aspect === aspect);
  if (!worker) throw new Error(`unknown remote Aspect: ${aspect}`);
  const member = identityMap.members[aspect];
  const channel = identityMap.channels[`aspect_${aspect}`];
  const runtime = runtimeMap.workers[aspect];
  const args = [
    "--relay-url",
    runtimeMap.relayUrl,
    "--private-key-file",
    member.secret_ref,
    "--expected-public-key",
    member.pubkey_hex,
    "--agent-owner",
    manifest.buzz.architectPubkey,
    "--agent-command",
    runtime.openclawPath,
    "--agent-args",
    [
      "acp",
      "--session",
      member.session_key,
      "--require-existing",
      "--token-file",
      runtime.gatewayTokenFile,
      "--url",
      runtime.gatewayUrl,
      "--provenance",
      "meta+receipt",
      "--no-prefix-cwd",
    ].join(","),
    "--agents",
    "1",
    "--subscribe",
    "config",
    "--config",
    runtime.configPath,
    "--respond-to",
    "owner-only",
    "--allowed-respond-to",
    "owner-only",
    "--base-prompt-file",
    runtime.basePromptPath,
    "--dedup",
    "queue",
    "--multiple-event-handling",
    "queue",
    "--relay-observer",
    "--trusted-inbound-envelope",
    "--no-agent-publisher-credentials",
    "--permission-mode",
    manifest.posture.permissionMode,
    "--heartbeat-interval",
    String(manifest.posture.heartbeatIntervalSecs),
    "--turn-liveness-secs",
    String(manifest.posture.turnLivenessSecs),
    "--idle-timeout",
    String(manifest.posture.idleTimeoutSecs),
    "--max-turn-duration",
    String(manifest.posture.maxTurnDurationSecs),
    "--context-message-limit",
    String(manifest.posture.contextMessageLimit),
    "--max-turns-per-session",
    String(manifest.posture.maxTurnsPerSession),
    "--turn-receipts",
    "--expected-gateway-session-key",
    member.session_key,
  ];
  assertTrustedPublisherContract(args, aspect, runtime.basePromptPath);
  if (args.includes("--no-memory")) {
    throw new Error(`${aspect}: Windows remote seat must retain memory`);
  }
  const task = renderTaskXml(manifest, runtimeMap, aspect, runtime.buzzAcpPath, args);
  return {
    schema: "aeon_buzz_acp_remote_windows_worker_v1",
    aspect,
    enabled: false,
    sessionKey: member.session_key,
    relayUrl: runtimeMap.relayUrl,
    command: runtime.buzzAcpPath,
    args,
    config: renderConfig(aspect, channel.channel_id, manifest.buzz.architectPubkey),
    basePrompt: renderPrompt(aspect),
    task,
    activationGate: {
      ...manifest.activationGate,
      blockers: [
        "reviewed tools.effective evidence is not attached",
        "public/social mutation absence or refusal is unproven",
        "capital mutation absence or refusal is unproven",
      ],
    },
    rollback: ["schtasks.exe", "/Change", "/TN", task.taskName, "/DISABLE"],
    secretFileContract: manifest.secretFileContract,
  };
}

export function evaluateRemoteSemanticHealth(evidence) {
  return evaluateSemanticHealth(evidence);
}
