import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_LABEL = /^[a-z0-9][a-z0-9._-]*$/;
const REQUIRED_AGENT_MODE = "agent-full-access";
const REQUIRED_CODEX_ACP_VERSION = "1.1.7";
const REQUIRED_CLAUDE_ACP_VERSION = "0.62.0";
const REQUIRED_CLAUDE_CODE_VERSION = "2.1.220";
const REQUIRED_CLAUDE_ACP_INTEGRITY =
  "sha512-8QRNmyk5Cfy4XVREeg5KCPoCDtmYS0xALY9WqI640PfopLMpeUzMByXbzLkBLbD819zB67DBhLG5ta98uOEPKg==";
const REQUIRED_CLAUDE_ACP_GIT_HEAD = "53a0c36ce3b0b76929d11d8b9565e319da745608";
const REQUIRED_CLAUDE_ACP_ENTRYPOINT_SHA256 = "260aac90bf75f197b93640087c1de66441761d43c2784efa035fdcee60b5dacd";
const REQUIRED_CLAUDE_ACP_CLOSURE_SHA256 = "7d8acbb9991aafe0560aaf03bcb7e7bb25ffe188c80bef67a5d7140700a6803f";
const REQUIRED_CLAUDE_CODE_SHA256 = "8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081";
const REQUIRED_CLAUDE_AUTH = {
  mode: "existing-claude-subscription",
  authMethod: "claude.ai",
  provider: "firstParty",
  subscriptionTypes: ["pro"],
};
const ANTHROPIC_CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const ENV_BINARY = "/usr/bin/env";
const WORKER_CONTRACTS = {
  codex_cli: {
    principal: "codex_cli",
    adapterKey: "codexAcp",
    adapterPackage: "@agentclientprotocol/codex-acp",
    adapterVersion: REQUIRED_CODEX_ACP_VERSION,
    label: "org.aeon.buzz-acp.codex-cli",
  },
  claude_cli: {
    principal: "claude_code",
    adapterKey: "claudeAcp",
    adapterPackage: "@agentclientprotocol/claude-agent-acp",
    adapterVersion: REQUIRED_CLAUDE_ACP_VERSION,
    label: "org.aeon.buzz-acp.claude-cli",
  },
};

export function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isAbsoluteSafePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !/[\0\r\n,]/.test(value);
}

export function hashPackageClosure(root) {
  if (!isAbsoluteSafePath(root)) throw new Error("package root must be an absolute safe path");
  const hash = createHash("sha256");
  const entries = [];

  function visit(directory, relativeDirectory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        entries.push({ kind: "file", absolutePath, relativePath, size: stat.size });
      } else if (stat.isSymbolicLink()) {
        entries.push({ kind: "symlink", relativePath, target: fs.readlinkSync(absolutePath) });
      } else {
        throw new Error(`unsupported package entry: ${relativePath}`);
      }
    }
  }

  visit(root, "");
  entries.sort((left, right) => {
    if (left.relativePath === right.relativePath) return 0;
    return left.relativePath < right.relativePath ? -1 : 1;
  });
  for (const entry of entries) {
    if (entry.kind === "symlink") {
      hash.update(`l\0${entry.relativePath}\0${entry.target}\0`);
    } else {
      hash.update(`f\0${entry.relativePath}\0${entry.size}\0`);
      hash.update(fs.readFileSync(entry.absolutePath));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

export function validateAmbientAnthropicCredentials(environment) {
  const present = ANTHROPIC_CREDENTIAL_ENV.filter(
    (name) => typeof environment?.[name] === "string" && environment[name].length > 0,
  );
  return {
    ok: present.length === 0,
    errors: present.map((name) => `${name} must be absent for Claude subscription authentication`),
  };
}

export function validateClaudeSubscriptionAuth(status, contract) {
  const errors = [];
  if (status?.loggedIn !== true) errors.push("Claude Code existing login is unavailable");
  if (status?.authMethod !== contract?.authMethod) {
    errors.push(`Claude Code auth method must be ${contract?.authMethod}`);
  }
  if (status?.apiProvider !== contract?.provider) {
    errors.push(`Claude Code API provider must be ${contract?.provider}`);
  }
  if (!contract?.subscriptionTypes?.includes(status?.subscriptionType)) {
    errors.push(`Claude Code subscription type must be one of: ${(contract?.subscriptionTypes ?? []).join(", ")}`);
  }
  return { ok: errors.length === 0, errors };
}

function memberPubkey(identityMap, memberId) {
  return identityMap.members?.[memberId]?.pubkey_hex;
}

function workerSelector(manifest) {
  return manifest.worker?.selector ?? manifest.worker?.principal;
}

function exactRoomIds(manifest, identityMap) {
  return [...manifest.buzz.sharedRooms, ...manifest.buzz.officeRooms].map(
    (roomId) => identityMap.channels?.[roomId]?.channel_id,
  );
}

export function validateManifest(manifest, identityMap) {
  const errors = [];
  const principal = manifest.worker?.principal;
  const selector = workerSelector(manifest);
  const member = identityMap.members?.[principal];
  const contract = WORKER_CONTRACTS[selector];

  if (manifest.schema !== "aeon_buzz_external_cli_worker_v1") {
    errors.push("unsupported external CLI worker schema");
  }
  if (manifest.enabled !== false) errors.push("external CLI worker must be disabled by default");
  if (!contract) errors.push("worker selector must be codex_cli or claude_cli");
  if (contract && principal !== contract.principal) {
    errors.push(`${selector} worker must bind to ${contract.principal}`);
  }
  if (manifest.worker?.agents !== 1) errors.push("exactly one ACP subprocess is required");
  if (!SAFE_LABEL.test(manifest.worker?.label ?? "")) errors.push("invalid launchd label");
  if (contract && manifest.worker?.label !== contract.label) {
    errors.push(`${principal} launchd label drift`);
  }
  if (!member) errors.push(`identity map is missing ${principal}`);
  if (member?.gateway_agent_id !== null || member?.aspect_slug !== null) {
    errors.push(`${principal} must remain an external non-Aspect principal`);
  }
  if (member?.concilium_seat !== principal) errors.push(`${principal} Concilium seat drift`);
  if (!HEX_64.test(member?.pubkey_hex ?? "")) errors.push(`${principal} pubkey must be 64 lowercase hex`);
  if (!isAbsoluteSafePath(member?.secret_ref)) {
    errors.push(`${principal} secret_ref must be an absolute safe path`);
  }

  const inbound = manifest.buzz?.allowedInbound ?? [];
  if (JSON.stringify(inbound) !== JSON.stringify(["architect", "nexus", "mechanon"])) {
    errors.push("inbound allowlist must be exactly Architect, Nexus, and Mechanon");
  }
  for (const memberId of inbound) {
    if (!HEX_64.test(memberPubkey(identityMap, memberId) ?? "")) {
      errors.push(`${memberId}: inbound identity is missing a valid pubkey`);
    }
  }
  if (manifest.buzz?.owner !== "architect") errors.push("Architect must own the worker");
  if (manifest.buzz?.relayUrl !== "ws://localhost:3000") errors.push("relay must remain loopback");
  if (JSON.stringify(manifest.buzz?.sharedRooms) !== JSON.stringify(["ops", "concilium"])) {
    errors.push("shared rooms must be exactly ops and concilium");
  }
  if ((manifest.buzz?.officeRooms ?? []).length !== 6) {
    errors.push("all six configured Aspect offices are required");
  }
  const roomIds = exactRoomIds(manifest, identityMap);
  if (roomIds.some((roomId) => typeof roomId !== "string")) errors.push("configured room is absent from identity map");
  if (new Set(roomIds).size !== roomIds.length) errors.push("configured rooms must be unique");
  for (const roomName of [...(manifest.buzz?.sharedRooms ?? []), ...(manifest.buzz?.officeRooms ?? [])]) {
    const members = identityMap.channels?.[roomName]?.members ?? [];
    if (!members.includes(principal)) errors.push(`${roomName}: ${principal} is not a member`);
  }

  const runtime = manifest.runtime;
  const adapter = contract ? runtime?.[contract.adapterKey] : undefined;
  if (contract && adapter?.package !== contract.adapterPackage) {
    errors.push(`${principal} ACP package owner drift`);
  }
  if (contract && adapter?.version !== contract.adapterVersion) {
    errors.push(`${principal} ACP adapter must be pinned to ${contract.adapterVersion}`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(adapter?.integrity ?? "")) {
    errors.push(`${principal} ACP integrity must be pinned`);
  }
  if (!HEX_64.test(adapter?.entrypointSha256 ?? "")) {
    errors.push(`${principal} ACP entrypoint SHA-256 must be pinned`);
  }
  if (selector === "claude_cli") {
    if (adapter?.integrity !== REQUIRED_CLAUDE_ACP_INTEGRITY) {
      errors.push("Claude ACP package integrity drift");
    }
    if (adapter?.gitHead !== REQUIRED_CLAUDE_ACP_GIT_HEAD) {
      errors.push("Claude ACP source checkpoint drift");
    }
    if (adapter?.entrypointSha256 !== REQUIRED_CLAUDE_ACP_ENTRYPOINT_SHA256) {
      errors.push("Claude ACP entrypoint checkpoint drift");
    }
    if (adapter?.closureSha256 !== REQUIRED_CLAUDE_ACP_CLOSURE_SHA256) {
      errors.push("Claude ACP package closure checkpoint drift");
    }
  }
  for (const [label, value] of Object.entries({
    buzzAcpBinary: runtime?.buzzAcpBinary,
    configPath: runtime?.configPath,
    adapterBinary: adapter?.binary,
  })) {
    if (!isAbsoluteSafePath(value)) errors.push(`${label} must be an absolute safe path`);
  }
  if (selector === "codex_cli") {
    if (!isAbsoluteSafePath(runtime?.codexHome)) errors.push("codexHome must be an absolute safe path");
    if (runtime?.initialAgentMode !== REQUIRED_AGENT_MODE) {
      errors.push(`INITIAL_AGENT_MODE must be ${REQUIRED_AGENT_MODE}`);
    }
  }
  if (selector === "claude_cli") {
    const claudeCode = runtime?.claudeCode;
    if (claudeCode?.version !== REQUIRED_CLAUDE_CODE_VERSION) {
      errors.push(`Claude Code must be pinned to ${REQUIRED_CLAUDE_CODE_VERSION}`);
    }
    if (!isAbsoluteSafePath(claudeCode?.binary)) errors.push("Claude Code binary must be an absolute safe path");
    if (!HEX_64.test(claudeCode?.binarySha256 ?? "")) {
      errors.push("Claude Code binary SHA-256 must be pinned");
    }
    if (claudeCode?.binarySha256 !== REQUIRED_CLAUDE_CODE_SHA256) {
      errors.push("Claude Code binary checkpoint drift");
    }
    if (claudeCode?.configDir !== undefined) {
      errors.push("Claude config directory override must be absent");
    }
    if (JSON.stringify(claudeCode?.auth) !== JSON.stringify(REQUIRED_CLAUDE_AUTH)) {
      errors.push("Claude auth must use the pinned Claude subscription login");
    }
  }
  if (!(runtime?.path ?? []).every(isAbsoluteSafePath)) errors.push("every PATH entry must be absolute and safe");
  if (!runtime?.path?.includes(path.dirname(adapter?.binary ?? ""))) {
    errors.push("PATH must include the pinned ACP adapter bin directory");
  }

  const workspaces = manifest.workspaces;
  if (!workspaces?.allowed?.[workspaces?.default]) errors.push("default workspace must be allowed");
  for (const [name, workspacePath] of Object.entries(workspaces?.allowed ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) errors.push(`invalid workspace name: ${name}`);
    if (!isAbsoluteSafePath(workspacePath) || !workspacePath.startsWith("/Volumes/AEON/Projects/")) {
      errors.push(`${name}: workspace must be a bounded AEON project path`);
    }
  }

  const posture = manifest.posture;
  if (posture?.subscribe !== "config") errors.push("worker must use config subscriptions");
  if (posture?.respondTo !== "allowlist") errors.push("worker must use inbound allowlist");
  if (JSON.stringify(posture?.allowedRespondTo) !== JSON.stringify(["allowlist"])) {
    errors.push("worker may only use allowlist response mode");
  }
  if (posture?.dedup !== "queue" || posture?.multipleEventHandling !== "queue") {
    errors.push("queue semantics must remain enabled");
  }
  for (const field of ["presence", "typing", "memory", "basePrompt", "relayObserver"]) {
    if (posture?.[field] !== true) errors.push(`${field} must remain enabled`);
  }
  const expectedPermissionMode = selector === "claude_cli" ? "bypass-permissions" : "default";
  if (posture?.permissionMode !== expectedPermissionMode) {
    errors.push(`${principal} Buzz permission mode must be ${expectedPermissionMode}`);
  }
  if (posture?.heartbeatIntervalSecs !== 0) errors.push("autonomous heartbeat prompts must remain off");
  if (manifest.supervisor?.runAtLoad !== false || manifest.supervisor?.keepAlive !== false) {
    errors.push("live activation must remain off");
  }

  return { ok: errors.length === 0, errors };
}

export function renderWorker(manifest, identityMap, workspaceName = manifest.workspaces.default) {
  const validation = validateManifest(manifest, identityMap);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));

  const workspace = manifest.workspaces.allowed[workspaceName];
  if (!workspace) throw new Error(`workspace is not allowed: ${workspaceName}`);
  const selector = workerSelector(manifest);
  const principal = identityMap.members[manifest.worker.principal];
  const contract = WORKER_CONTRACTS[selector];
  const adapter = manifest.runtime[contract.adapterKey];
  const allowlist = manifest.buzz.allowedInbound
    .filter((memberId) => memberId !== manifest.buzz.owner)
    .map((memberId) => memberPubkey(identityMap, memberId));
  const buzzArgs = [
    "--relay-url",
    manifest.buzz.relayUrl,
    "--private-key-file",
    principal.secret_ref,
    "--expected-public-key",
    principal.pubkey_hex,
    "--agent-owner",
    memberPubkey(identityMap, manifest.buzz.owner),
    "--agent-command",
    adapter.binary,
    "--agent-publisher-credentials",
    "--agents",
    "1",
    "--subscribe",
    "config",
    "--config",
    manifest.runtime.configPath,
    "--respond-to",
    "allowlist",
    "--respond-to-allowlist",
    allowlist.join(","),
    "--allowed-respond-to",
    "allowlist",
    "--dedup",
    "queue",
    "--multiple-event-handling",
    "queue",
    "--relay-observer",
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
  ];
  const claudeScrubPrefix = ANTHROPIC_CREDENTIAL_ENV.flatMap((name) => ["-u", name]);
  return {
    enabled: false,
    label: manifest.worker.label,
    workspaceName,
    workingDirectory: workspace,
    command: selector === "claude_cli" ? ENV_BINARY : manifest.runtime.buzzAcpBinary,
    args:
      selector === "claude_cli"
        ? [...claudeScrubPrefix, manifest.runtime.buzzAcpBinary, ...buzzArgs]
        : buzzArgs,
    environment:
      selector === "codex_cli"
        ? {
            PATH: manifest.runtime.path.join(":"),
            CODEX_HOME: manifest.runtime.codexHome,
            INITIAL_AGENT_MODE: manifest.runtime.initialAgentMode,
          }
        : {
            PATH: manifest.runtime.path.join(":"),
            CLAUDE_CODE_EXECUTABLE: manifest.runtime.claudeCode.binary,
          },
    signerFile: principal.secret_ref,
    expectedPublicKey: principal.pubkey_hex,
  };
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderDisabledLaunchAgent(manifest, identityMap, workspaceName) {
  const worker = renderWorker(manifest, identityMap, workspaceName);
  const argvXml = [worker.command, ...worker.args].map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const envXml = Object.entries(worker.environment)
    .map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("\n");
  const selector = workerSelector(manifest);
  const logRoot = `/Volumes/AEON/runtime/buzz/external-cli/${selector}/logs`;
  const logName = selector.replace("_", "-");

  return {
    ...worker,
    requiredDirectories: [path.dirname(manifest.runtime.configPath), logRoot],
    runAtLoad: false,
    keepAlive: false,
    rollback: ["launchctl", "bootout", `gui/<uid>/${worker.label}`],
    plist: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(worker.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argvXml}
  </array>
  <key>WorkingDirectory</key><string>${xml(worker.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${logRoot}/${logName}.log</string>
  <key>StandardErrorPath</key><string>${logRoot}/${logName}.err.log</string>
</dict>
</plist>
`,
  };
}

function exactTag(tags, expected) {
  return tags.filter((tag) => tag.length === expected.length && tag.every((value, index) => value === expected[index]));
}

export function correlateVerifiedReceipt({ requestEventId, channelId, replyEvent, observerRun, expectedPubkey }) {
  if (!HEX_64.test(requestEventId) || !HEX_64.test(expectedPubkey)) {
    throw new Error("request and signer ids must be 64 lowercase hex");
  }
  if (replyEvent?.verified !== true) throw new Error("reply signature must be verified");
  if (replyEvent?.kind !== 9 || replyEvent?.pubkey !== expectedPubkey || !HEX_64.test(replyEvent?.id ?? "")) {
    throw new Error("reply identity mismatch");
  }
  if (exactTag(replyEvent.tags ?? [], ["h", channelId]).length !== 1) {
    throw new Error("reply requires one exact channel tag");
  }
  if (exactTag(replyEvent.tags ?? [], ["e", requestEventId, "", "reply"]).length !== 1) {
    throw new Error("reply requires one exact request anchor");
  }
  if (
    observerRun?.requestEventId !== requestEventId ||
    observerRun?.replyEventId !== replyEvent.id ||
    observerRun?.channelId !== channelId ||
    !observerRun?.sessionId ||
    !observerRun?.runId
  ) {
    throw new Error("observer run correlation mismatch");
  }
  return {
    requestEventId,
    replyEventId: replyEvent.id,
    sessionId: observerRun.sessionId,
    runId: observerRun.runId,
    channelId,
  };
}
