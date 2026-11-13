# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or contact the maintainers listed in `package.json` if the advisory flow is unavailable. Do not open a public issue for an unpatched vulnerability. Include:

- affected version and platform,
- a minimal reproduction (tool call sequence or HTTP request),
- the impact you observed,
- whether secrets or a user repository could be reached.

We aim to acknowledge reports within 72 hours and to publish a fix or a mitigation plan within 14 days for confirmed issues.

## Threat model

dsh-swarm runs inside a DeepSeek Harness profile and inherits its sandbox, approval policy, and credentials. The swarm layer adds these surfaces:

| Surface | Risk | Mitigation |
| --- | --- | --- |
| Blackboard writes | A member pastes a token into a fact | Write-time and read-time redaction (`sk-`, `ghp_`, `AKIA`, Bearer, private keys, high-entropy strings); credential-named keys are replaced wholesale |
| Event log | Secrets persisted forever | `scrub()` runs on every payload before the JSONL append; logs are local under `$DSH_HOME/swarm` |
| Cross-run access | A member reads another swarm's state | Every command resolves the run from the service map; unknown ids fail with `RUN_NOT_FOUND` |
| Privilege escalation | A worker asks for more tools than its parent | Members are created by the host and inherit the parent sandbox; the swarm layer never grants capabilities |
| Prompt injection | Repository text becomes an instruction | Repository text is treated as data; the protocol section says so explicitly; task cards carry acceptance criteria, not authority |
| Local HTTP API | Another local process reads or mutates swarm state | Loopback peer check; reads are open, writes require `http.token` (Bearer / `x-swarm-token`) and are disabled when the token is empty; cross-origin writes are rejected |
| Merge queue | A stale worker writes after reassignment | Fenced leases (`STALE_LEASE`), single integration writer, per-task branches |
| Audit | An operator deletes an inconvenient event | Events are append-only; the hash chain makes silent edits detectable; interventions carry actor and reason |

## Safe defaults

- `preflight.enabled: true` refuses obviously unsafe repositories (missing directory, unwritable, low disk).
- `budget.hardStop: true` stops the run instead of overspending.
- `review.requireEvidence: true` keeps approval-only votes from counting.
- The HTTP API binds to the host's loopback server; writes are off until `http.token` is configured and never accept cross-origin requests.

## Out of scope for 0.1.0

- Remote or multi-machine swarms.
- Running untrusted code outside the host sandbox.
- Automatic deployment or production configuration changes.
