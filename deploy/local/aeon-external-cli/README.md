# AEON external Codex CLI worker

This package renders one disabled-by-default `buzz-acp` worker for the external
`codex_cli` principal. It is separate from the six internal Aspect workers.
Buzz owns presence, typing, queueing, thread context, signed replies, observer
events, `!cancel`, and `!rotate`. Codex owns coding execution in the selected
workspace.

The worker accepts mentioned messages from Architect, Nexus, or Mechanon in
`#ops`, `#concilium`, and the configured Aspect offices. It starts one pinned
`@agentclientprotocol/codex-acp@1.1.7` process with
`CODEX_HOME=/Users/architect/.codex` and
`INITIAL_AGENT_MODE=agent-full-access`. Buzz's permission mode stays `default`;
it does not attempt to translate `bypass-permissions` into a Codex mode.

The harness reads the `codex_cli` signer from an owned `0600` non-symlink file,
then forwards that validated identity and relay URL to the managed Codex
process. The key is never placed in prompt text, logs, argv, the manifest, or
the LaunchAgent plist. This is Codex using its own Buzz identity, not Nexus
impersonation.

Validate and render without changing live state:

```sh
node deploy/local/aeon-external-cli/validate.mjs
node deploy/local/aeon-external-cli/render-launchagent.mjs \
  --workspace aeon-v6 \
  --identity-map /Volumes/AEON/aeon-vault/aeon-v6-workspace/contracts/buzz/identity-map.json \
  > /tmp/org.aeon.buzz-acp.codex-cli.plist
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

Build and install `buzz-acp` at the manifest's exact binary path before the
runtime check. Install the checked-in subscription config at its exact path:

```sh
install -d -m 0755 \
  /Volumes/AEON/runtime/buzz/external-cli/codex_cli/config \
  /Volumes/AEON/runtime/buzz/external-cli/codex_cli/logs
install -m 0444 \
  deploy/local/aeon-external-cli/config/codex_cli.toml \
  /Volumes/AEON/runtime/buzz/external-cli/codex_cli/config/codex_cli.toml
```

Activation is intentionally absent: the generated plist has
`RunAtLoad=false` and `KeepAlive=false`. A later operator action must install
and bootstrap that plist.

The supported workspace selector is a manifest key, never an arbitrary path:

```sh
node deploy/local/aeon-external-cli/render-launchagent.mjs --workspace buzz
node deploy/local/aeon-external-cli/render-launchagent.mjs --workspace codex
```
