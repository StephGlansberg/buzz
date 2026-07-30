# AEON remote Aspect Buzz workers

This source-only package prepares two disabled Windows Buzz ACP seats:
`FAMA` and `Opulentis`. It does not register a Scheduled Task, create a Buzz
identity or room, start or reload OpenClaw, send a Buzz/A2A message, or grant a
social/capital mutation.

The workers run on the Windows authority host and connect outbound to an
operator-reviewed, credential-free non-loopback WSS relay origin. The expected
Mac relay is shown in the synthetic fixture, but source does not claim that
hostname is configured or live on Windows. Each seat binds one pre-created
fixed `agent:<reviewed-agent-id>:buzz-private` Gateway session. The renderer
does not guess whether the Windows agent ID is `main`, `fama`, `opulentis`, or
another installed ID. The reviewed identity input must supply the exact
`gateway_agent_id` and matching `session_key`; activation stops on any mismatch.

The current read-only Windows inventory grounds two non-secret runtime facts:
FAMA's Gateway is `ws://127.0.0.1:18821` under Task Scheduler root `\FAMA\`;
Opulentis uses `ws://127.0.0.1:18820` under `\Opulentis\`. The renderer enforces
those values. Neither host currently has a Buzz worker, identity, private
office, or verified canonical-WSS configuration, so those inputs remain
explicit admission work rather than inferred defaults.

## One owner, two remote seats

The package imports the existing
`deploy/local/aeon-aspects/worker.mjs` prompt and semantic-health owners. It
does not add FAMA or Opulentis to the Mac `aeon-aspects/workers.json`; that
manifest remains exactly the six local Mac Aspects. Windows owns both remote
OpenClaw runtimes, state, memory, and tools. Buzz is the shared conversation
transport.

Memory remains enabled: the rendered argv intentionally omits `--no-memory`.
The trusted inbound envelope, exact per-seat base prompt, publisher credential
isolation, and turn receipts are indivisible. The spawned OpenClaw process
receives neither the Buzz relay URL nor the Aspect private key. Only the
contextual `buzz_fama_reply` or `buzz_opulentis_reply` path may publish the
final anchored response.

This admission cut authorizes conversation and read-only inspection only.
FAMA public/social publication and Opulentis trades, transfers, orders, and
capital-position changes require a separate explicit job and approval
contract. A prompt cannot remove authority already present in a Windows
OpenClaw tool policy, so the package creates no such authority and keeps both
tasks disabled. `activationAllowed` remains false until actual
`tools.effective` evidence proves that both public/social and capital mutation
are absent or refused in the exact dedicated session.

## Render, do not install

The checked-in fixtures contain explicitly synthetic public identities,
channels, agent IDs, sessions, and paths. They are test inputs only. To prepare
real artifacts, supply reviewed identity and runtime maps:

```powershell
node deploy/local/aeon-remote-aspects/render-windows-workers.mjs `
  C:\path\to\reviewed-identity-map.json `
  C:\path\to\reviewed-runtime-map.json `
  > C:\path\to\review\aeon-remote-workers.json
```

The output contains the exact TOML room rule, private-office prompt, complete
`buzz-acp.exe` argv, and disabled Task Scheduler XML for each seat. Rendering
does not write any target file. An operator must review and place the TOML and
prompt at the paths declared in the runtime map before registering a task.

Every actual private room must contain exactly Architect plus its Aspect.
Every identity must have a distinct key and room. The local Gateway URL must
remain loopback. The canonical relay must remain WSS.

## Readiness evidence

Windows operators can collect comparable, non-secret posture evidence without
installing or starting a worker:

```powershell
.\deploy\local\aeon-remote-aspects\collect-readiness.ps1 `
  -Aspect fama `
  -IdentityMapPath C:\path\to\reviewed-identity-map.json `
  -RuntimeMapPath C:\path\to\reviewed-runtime-map.json `
  -PolicyEvidenceMapPath C:\path\to\reviewed-policy-evidence.json `
  > C:\path\to\review\readiness.json
```

The collector never reads or prints private-key or Gateway-token contents. It
reports owner SID, DACL/reparse posture, non-secret binary/config/prompt hashes,
loopback Gateway reachability, fixed session and public identity, and the
mutation-policy declaration. Missing infrastructure readiness exits `2`. It
always emits `selected_activation_allowed=false`: a policy declaration and its
hash are useful review inputs but cannot authorize activation. The collector
reports both seats for comparison, while its exit status gates the selected
seat's base readiness so FAMA can be prepared before Opulentis.

The optional policy-evidence map has this minimal review shape:

```json
{
  "schema": "aeon_buzz_remote_windows_policy_evidence_v1",
  "workers": {
    "fama": {
      "session_key": "agent:<reviewed-agent-id>:buzz-private",
      "tools_effective_path": "C:\\path\\to\\fama-tools-effective.json",
      "tools_effective_sha256": "<reviewed lowercase sha256>",
      "public_social_mutation": "absent_or_refused",
      "capital_mutation": "absent_or_refused",
      "reviewed_by": "<operator>",
      "reviewed_at": "<RFC3339>"
    }
  }
}
```

Opulentis uses the same fields. The collector binds the file hash and fixed
session, but the operator remains responsible for reviewing the actual
effective-tool inventory. No OpenClaw config shape is inferred here.

## Windows key contract

`buzz-acp --private-key-file` now opens a Windows key with
`FILE_FLAG_OPEN_REPARSE_POINT`, rejects reparse points, and reads the secret
from that same validated handle. The file owner SID must equal the current
process user. Its DACL may grant access only to that user, `SYSTEM`, and
`Administrators`. `--expected-public-key` remains mandatory in every rendered
worker and verifies the key-to-seat binding.

The Gateway token is not read by `buzz-acp`; Windows/OpenClaw must independently
apply and prove the same owner-only file posture before activation.

## Activation and proof

Registration and activation are deliberately outside this package. Admit one
seat at a time, FAMA first:

1. Prove the existing Windows Gateway agent and fixed session.
2. Prove private key and Gateway token owner/DACL posture without printing
   either secret.
3. Render and compare the complete argv and disabled Scheduled Task.
4. Run the readiness collector and require
   `selected_readiness_passed=true` for only the selected seat. Source still
   reports `selected_activation_allowed=false`; review the bound effective-tool
   evidence before a separate activation action.
5. Register disabled, then enable/restart only the selected seat.
6. Prove relay connection and exact private-room subscription.
7. Send one ordinary Architect turn and require exactly one signed anchored
   reply, the fixed session, a fresh run ID, memory recall, and no external
   effect.
8. Run the existing semantic owner:

   ```powershell
   node deploy/local/aeon-aspects/semantic-health.mjs C:\path\to\evidence.json
   ```

9. On failure disable only that task:

   ```powershell
   schtasks.exe /Change /TN \FAMA\AEON-Buzz-fama /DISABLE
   ```

Only after FAMA is green should the same sequence run for Opulentis.
