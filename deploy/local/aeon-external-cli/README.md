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
Its adapter installation, runtime signer, subscription config, and logs live below
`/Users/architect/Library/Application Support/AEON/aeon-v6`, matching the
launchd-safe Data-volume layout used by the working Codex worker. Selected
workspace paths may remain below `/Volumes/AEON/Projects`.
Both services reuse the canonical shared
`/Users/architect/Library/Application Support/AEON/aeon-v6/bin/buzz-acp`;
neither worker installs or maintains a private harness executable. Both
manifests pin the release at SHA-256
`107bbe8ba44f14ac114ecc434f09a05dc6ed9aee3e15ca8ca3647d496e781c53`.
The pinned harness supports
`--session-cwd` and requires the explicit `--agent-publisher-credentials`
grant, so the renderer cannot silently depend on legacy default forwarding.
The LaunchAgent PATH resolves the trusted
`/Users/architect/.nvm/versions/node/v24.1.0/bin/node` first. That runtime is
pinned at SHA-256
`59450bb6448c8a40b3f3b86da45c3babb2e0503e04c47e5a715e8e137389878b`.
Runtime validation rejects symlinks, non-regular files, non-executable or
non-`0755` modes, hash drift, and version drift. The service does not use the
Data-volume Node copy, whose filesystem watcher cannot reliably watch the
selected workspace on `/Volumes`.
The Claude supervisor itself starts from the Data-volume runtime root, so
launchd and Node never resolve the process cwd through `/Volumes`. The selected
manifest workspace is passed separately as `--session-cwd`; `buzz-acp`
validates that explicit path is absolute and is an existing directory, then
uses it for ACP `session/new`. Workers that omit `--session-cwd` retain the
current process working directory.
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
```

Install the pinned Claude adapter into its exact manifest path:

```sh
npm install \
  --prefix '/Users/architect/Library/Application Support/AEON/aeon-v6/claude-acp/0.62.0' \
  --save-exact --ignore-scripts --no-audit --no-fund \
  @agentclientprotocol/claude-agent-acp@0.62.0
```

Build and install the one shared `buzz-acp` release at the path pinned by both
manifests before either runtime check. Install the checked-in subscription
config at its exact path:

```sh
cargo build --release -p buzz-acp
install -d -m 0755 \
  /Volumes/AEON/runtime/buzz/external-cli/codex_cli/config \
  /Volumes/AEON/runtime/buzz/external-cli/codex_cli/logs
install -m 0444 \
  deploy/local/aeon-external-cli/config/codex_cli.toml \
  /Volumes/AEON/runtime/buzz/external-cli/codex_cli/config/codex_cli.toml
install -d -m 0755 \
  '/Users/architect/Library/Application Support/AEON/aeon-v6/bin' \
  '/Users/architect/Library/Application Support/AEON/aeon-v6/buzz' \
  '/Users/architect/Library/Application Support/AEON/aeon-v6/logs'
install -m 0500 \
  target/release/buzz-acp \
  '/Users/architect/Library/Application Support/AEON/aeon-v6/bin/buzz-acp'
install -d -m 0700 \
  '/Users/architect/Library/Application Support/AEON/aeon-v6/secrets'
install -m 0444 \
  deploy/local/aeon-external-cli/config/claude_cli.toml \
  '/Users/architect/Library/Application Support/AEON/aeon-v6/buzz/claude-cli.toml'
install -m 0600 \
  /Volumes/AEON/Projects/buzz-data/keys/claude_code.sk \
  '/Users/architect/Library/Application Support/AEON/aeon-v6/secrets/claude-code.sk'
node deploy/local/aeon-external-cli/validate.mjs \
  /Volumes/AEON/aeon-vault/aeon-v6-workspace/contracts/buzz/identity-map.json \
  --runtime
node deploy/local/aeon-external-cli/validate.mjs \
  /Volumes/AEON/aeon-vault/aeon-v6-workspace/contracts/buzz/identity-map.json \
  --worker claude_cli \
  --runtime
```

The signer copy command emits no key material. Canonical identity-map
membership and `secret_ref` remain unchanged; runtime validation passes the
Data-volume copy and canonical `claude_code` pubkey through the shared
`buzz-acp` safe signer reader. That reader opens with no symlink following,
requires a current-user-owned regular file with exact mode `0600`, and rejects
any key that does not derive the canonical pubkey.

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
