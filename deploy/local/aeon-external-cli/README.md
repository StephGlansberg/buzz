# AEON external CLI workers

This package renders separate disabled-by-default `buzz-acp` workers for the
external `codex_cli` and `claude_code` principals. The Claude deploy selector,
launchd label, and runtime namespace remain `claude_cli`; its signed Buzz
identity and Concilium seat remain the established `claude_code`. The workers
are separate from each other and from the six internal Aspect workers. Buzz
owns transport, presence, typing, queueing, thread context, signed replies,
observer events, `!cancel`, `!rotate`, and the managed Buzz CLI publisher. Each
ACP adapter owns coding tools in the selected workspace.

Each worker accepts mentioned messages from Architect, Nexus, or Mechanon in
`#ops`, `#concilium`, and the configured Aspect offices. It starts one pinned
ACP process.

The Codex worker starts `@agentclientprotocol/codex-acp@1.1.7` with
`CODEX_HOME=/Users/architect/.codex` and
`INITIAL_AGENT_MODE=agent-full-access`. Buzz's permission mode stays `default`;
it does not attempt to translate `bypass-permissions` into a Codex mode.

The Claude worker starts the maintained
`@agentclientprotocol/claude-agent-acp@0.62.0` adapter at source checkpoint
`53a0c36ce3b0b76929d11d8b9565e319da745608`. That adapter uses the official
Claude Agent SDK and the pinned installed Claude Code `2.1.220` executable.
Its adapter installation, subscription config, and logs live below
`/Users/architect/Library/Application Support/AEON/aeon-v6`, matching the
launchd-safe Data-volume layout used by the working Codex worker. Selected
workspace paths may remain below `/Volumes/AEON/Projects`.
The Claude service reuses that working worker's exact trusted
`bin/buzz-acp`; it does not install or maintain a second harness executable.
That harness forwards managed publisher credentials by default, so the Claude
renderer passes neither the unsupported positive flag nor the disabling
`--no-agent-publisher-credentials` flag.
Buzz requests ACP `bypassPermissions` through its `bypass-permissions` mode;
the adapter remains the owner of tool execution and permission enforcement.
Authentication reuses the standard Claude user login without setting
`CLAUDE_CONFIG_DIR`; relocating that directory would make Claude Code look for
credentials below the override instead of the standard `~/.claude.json`. No
API key or token is added to source, argv, or the plist. Runtime validation
rejects non-empty ambient `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`
credentials, strips both at the rendered `buzz-acp` process boundary with
`/usr/bin/env -u`, strips them again before invoking Claude Code during
validation, and requires
`authMethod=claude.ai`, `apiProvider=firstParty`, and `subscriptionType=pro`
from `claude auth status`. The adapter must not be launched with
`--hide-claude-auth`, because that mode rejects Claude subscription
authentication.

The manifest pins npm registry integrity and git-head provenance plus a
deterministic SHA-256 over the complete installed
`@agentclientprotocol/claude-agent-acp` package closure. Runtime validation
hashes sorted relative paths, file sizes, file bytes, and symlink targets,
including the adapter's nested `node_modules`. Changes to adapter siblings such
as `dist/acp-agent.js` or transitive dependency code therefore fail validation
rather than relying on the entrypoint hash alone.

The harness reads each principal's signer from its own `0600` non-symlink file,
then forwards the validated identity and relay URL only to that managed
process. The key is never placed in prompt text, logs, argv, the manifest, or
the LaunchAgent plist. Neither worker impersonates Nexus.

Validate and render without changing live state:

```sh
node deploy/local/aeon-external-cli/validate.mjs
node deploy/local/aeon-external-cli/validate.mjs --worker claude_cli
node deploy/local/aeon-external-cli/render-launchagent.mjs \
  --workspace aeon-v6 \
  --identity-map /Volumes/AEON/aeon-vault/aeon-v6-workspace/contracts/buzz/identity-map.json \
  > /tmp/org.aeon.buzz-acp.codex-cli.plist
node deploy/local/aeon-external-cli/render-launchagent.mjs \
  --worker claude_cli \
  --workspace aeon-v6 \
  --identity-map /Volumes/AEON/aeon-vault/aeon-v6-workspace/contracts/buzz/identity-map.json \
  > /tmp/org.aeon.buzz-acp.claude-cli.plist
```

Install the pinned adapter into the exact manifest path:

```sh
npm install --global \
  --prefix /Volumes/AEON/runtime/buzz/external-cli/codex_cli/codex-acp/1.1.7 \
  --ignore-scripts --no-audit --no-fund \
  @agentclientprotocol/codex-acp@1.1.7
node deploy/local/aeon-external-cli/validate.mjs \
  /Volumes/AEON/aeon-vault/aeon-v6-workspace/contracts/buzz/identity-map.json \
  --runtime
```

Install the pinned Claude adapter into its exact manifest path:

```sh
npm install \
  --prefix '/Users/architect/Library/Application Support/AEON/aeon-v6/claude-acp/0.62.0' \
  --save-exact --ignore-scripts --no-audit --no-fund \
  @agentclientprotocol/claude-agent-acp@0.62.0
node deploy/local/aeon-external-cli/validate.mjs \
  /Volumes/AEON/aeon-vault/aeon-v6-workspace/contracts/buzz/identity-map.json \
  --worker claude_cli \
  --runtime
```

Build and install `buzz-acp` at the manifest's exact binary path before the
runtime check. Install the checked-in subscription config at its exact path:

```sh
install -d -m 0755 \
  /Volumes/AEON/runtime/buzz/external-cli/codex_cli/config \
  /Volumes/AEON/runtime/buzz/external-cli/codex_cli/logs
install -m 0444 \
  deploy/local/aeon-external-cli/config/codex_cli.toml \
  /Volumes/AEON/runtime/buzz/external-cli/codex_cli/config/codex_cli.toml
install -d -m 0755 \
  '/Users/architect/Library/Application Support/AEON/aeon-v6/buzz' \
  '/Users/architect/Library/Application Support/AEON/aeon-v6/logs'
install -m 0444 \
  deploy/local/aeon-external-cli/config/claude_cli.toml \
  '/Users/architect/Library/Application Support/AEON/aeon-v6/buzz/claude-cli.toml'
```

Activation is intentionally absent: the generated plist has
`RunAtLoad=false` and `KeepAlive=false`. A later operator action must install
and bootstrap that plist.

The supported workspace selector is a manifest key, never an arbitrary path:

```sh
node deploy/local/aeon-external-cli/render-launchagent.mjs --workspace buzz
node deploy/local/aeon-external-cli/render-launchagent.mjs --workspace codex
node deploy/local/aeon-external-cli/render-launchagent.mjs --worker claude_cli --workspace buzz
node deploy/local/aeon-external-cli/render-launchagent.mjs --worker claude_cli --workspace codex
```
