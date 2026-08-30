# AEON Buzz capability audit — 2026-08-30

This is the durable source checkpoint for upgrading AEON's Buzz deployment
without replacing its private-office, trusted-context, receipt, or supervisor
contracts. It records source evidence only. It does not authorize a Desktop,
relay, worker, or Gateway cutover.

## Pinned source identities

- Published Desktop control: `desktop-v0.5.20` at
  `95154bee4034ca7a40b33095c2ddbde8c9aa1614`.
- Upstream integration base: `origin/main` at
  `eed74bde2f4797714335ac10c56c0b0244c1def4`.
- AEON integration branch: `codex/aeon-buzz-upstream-integration-20260830`,
  created from the clean AEON spine `0185502b203a57fe56ded378869c7dd39d3e7785`
  and merged with the pinned upstream main.
- Installed Desktop observed before this work: `0.5.1`. No installed app or
  runtime was changed by this audit.

The 0.5.20 control checkout builds `buzz`, `buzz-acp`, and `buzz-relay` in
release mode. Its focused CLI and SDK mention tests pass. The integrated branch
must repeat those proofs after the AEON-preservation patches below settle.

## Capability decisions

### Adopt in the next immutable candidate

- Desktop 0.5.20 media and composer improvements, including GIF search,
  image navigation/zoom, portrait video, and the post-send automatic-mention
  preference.
- Current-main exact typed-mention commit-on-Space behavior.
- Current-main signature preservation on CLI message/feed reads. Exact signed
  events are required evidence for an agent-operated UI.
- Current-main agent stop-reason and silent-turn telemetry.
- The existing AEON trusted inbound envelope, publisher credential isolation,
  exact Gateway session binding, durable reply lifecycle, turn receipts,
  verified inbound media, filter deadlines, invited-room admission, Canvas
  compare-set contract, and semantic worker health checks.

### Stage behind a separate proof gate

- Mobile 0.16 push notifications. The source capability exists on main, but
  production still needs entitlements and push infrastructure proof.
- Team catalog and project-home features. These should be adopted as coherent
  feature slices, not as isolated UI commits.
- Mobile Huddles and other release-candidate mobile work.
- Standing/per-turn ACP tags and thread-context deduplication.

### Keep non-autonomous until upstream contracts close

- Workflow scheduling, deletion, and run history. Current issues show that a
  schedule may not fire, delete can acknowledge without deleting, and run
  history is incomplete.
- Broad project/workflow mutations from unattended agents.
- Mobile release-candidate features that lack deployed infrastructure proof.
- Any mutable `main` image or binary reference. Production artifacts must be
  pinned by source and payload identity.

## Mention correctness matrix

| Layer | Current upstream state | Required AEON state |
| --- | --- | --- |
| CLI addressing | 0.5.20 uniquely resolves roster names, supports repeatable explicit `--mention`, validates membership, caps recipients at 50, and reports signed-event `mention_pubkeys` | Preserve; add Markdown-wrapper and CJK-adjacent parser coverage |
| Desktop composer | Main commits exact typed mentions on Space and deduplicates overlapping live mention/channel delivery by event ID | Preserve; prove remote Aspect discovery from every authorized client |
| Mobile composer | Selected mentions carry explicit pubkeys; manually typed unselected names remain inconsistent | Align with unique-or-explicit fail-closed behavior |
| Relay persistence | Event and `event_mentions` can commit separately | Make event, thread metadata, and mention index one transaction |
| Relay validation | Ordinary message `p` tags are not strictly canonicalized/capped at ingress | Require distinct lowercase 64-hex addressing tags and a bounded message-kind cap; exempt roster kinds |
| ACP intake | Default mention mode covers stream messages, approvals, and reminders but not every authored surface | Add only justified addressed kinds; keep exact event-ID dedup and fail-closed admission |
| Notifications | Channel mentions are live; Pulse mentions can be silent while Desktop is unfocused | Add a narrow live notification-bearing Pulse path without restoring broad background polling |
| Historical display | Alias links use current profile names and can collide after rename | Never link an ambiguous historical label to the wrong identity |

Edits are a policy decision, not a parser bug. Desktop signs newly added edit
recipients, but kind 40003 is excluded from Home, notification, and ACP mention
intake. If edits become notifying, only newly added recipients should wake once,
and navigation must anchor to the edited target message.

## Agent CLI audit

Using the `mechanon_agent_dx_cli_audit_v1` rubric, upstream `buzz-cli` scores
**9/21 (agent-tolerant)**. The integrated candidate raises the schema axis from
0 to 2 by adding deterministic `buzz --version` and `buzz schema`, for **11/21
(agent-ready)**. It is still not scheduler-ready:

| Axis | Score | Evidence |
| --- | ---: | --- |
| Machine-readable output | 2 | JSON default, structured stderr, write receipts; no NDJSON pagination |
| Raw payload input | 1 | Several stdin surfaces, no common schema-shaped JSON mutation input |
| Schema introspection | 2 in candidate | Versioned recursive Clap schema, package/source identity, and secret-redacted env metadata |
| Context discipline | 1 | Some hard limits/compact output; unbounded lists and no continuation receipts remain |
| Input hardening | 2 | Strong identity/event validation; malformed `--kinds`, output overwrite, and upload preflight gaps remain |
| Safety rails | 1 | Dry-run is not general across mutations |
| Packaged agent knowledge | 2 | Strong ACP base prompt and testing docs; no versioned machine-readable command schema |

The candidate CLI is suitable for supervised messages, Canvas, reads, and bounded media
operations. It is not yet a safe general scheduler/control plane. The minimum
agent-DX follow-up is fail-closed `--kinds`, bounded list cursors, upload size
preflight, output-root / no-clobber protection, and dry-run for high-impact
mutations.

## Integrated source checkpoint

The following signed-off commits are layered over the upstream/AEON merge and
remain source-only:

- `ab6f29164deefbf987d7e3e71f37ec9f0b9786d5` — Markdown/CJK mention
  boundaries with email/identifier safety.
- `a8339857b7e46b8accb7b743791897fe704617a8` — compiled Buzz prompt plus
  per-Aspect system-office prompt and indivisible trusted publisher contract.
- `68b01f951c1f407c65377d89c38dcd0ec7c09db2` — canonical lowercase,
  duplicate-free, maximum-50 addressing tags for conversational kinds; large
  roster kinds remain exempt.
- `e1b3558475f535741b0997b9d5a7ef4ddf7ed0bf` — event/thread/reaction/lease/
  relay-member mention indexes commit in the owning transaction.
- `aaf95a6844f284b7f3f0d7b0e2669d2efdbba08c` — deterministic CLI version and
  machine-readable command schema.

## Cutover acceptance

Before installing or switching anything:

1. Build the integrated `buzz`, `buzz-acp`, `buzz-relay`, and Desktop from the
   pinned branch.
2. Run focused mention/parser, database atomicity, ACP contract, worker renderer,
   Desktop, and mobile analysis/tests.
3. Render all existing workers from clean source and compare complete argv,
   sessions, identities, tokens, prompts, supervisor fields, and running/off
   parity with live state.
4. Back up the Desktop application data and persistent relay volumes. Do not
   migrate the community or keys.
5. Produce immutable binaries/images and a rollback manifest with source and
   payload hashes.
6. Canary one Architect-to-Nexus mention from Desktop and mobile, proving one
   signed request, one ACP intake, one tool-governed anchored reply, and one
   semantic health receipt.
7. Roll out the other Aspects one at a time. Keep broader workflows and new
   mobile infrastructure behind their own gates.
