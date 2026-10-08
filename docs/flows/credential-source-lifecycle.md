---
created: "2026-09-26"
updated: 2026-10-08
last_updated_session: agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110
---

# Credential source lifecycle Flow

## Overview

An authorized caller registers a Namespace Secret with the Credential Gateway,
binds it to an Agent, deploys, updates or withdraws it, and deletes the source.
The gateway holds Secret values; OCC stores metadata and references. Admission
freezes identity in the AgentRevision; the worker passes the live record to Compute.
[OpenShell Sandbox provisioning](openshell-sandbox-provisioning.md) covers attachment and readiness.

## Entry Points

- Trigger: `POST`, `PATCH`, or `DELETE /namespaces/:namespaceId/credential-sources[/:credentialSourceId]`,
  Agent create or PATCH and `POST …/agents/:agentId/deploy`, and
  `POST …/agents/:agentId/credential-sources/:credentialSourceId/withdraw`.
- Source: `apps/controller/src/http/credential-sources.ts:createCredentialSource`
- Source: `packages/occ/src/index.ts:createCredentialSource`
- Source: `packages/occ/src/index.ts:deleteCredentialSource`
- Assumptions: the Installation selected a Credential Gateway that belongs to an
  `openshell` Backend, a Sandbox, and bundled Kubernetes Compute; the Namespace
  is `ready`; the caller holds the grants named in each phase.

## Flow

```mermaid
graph TD
  A["<b>POST credential source</b><br/>API request"] --> B{"<b>Catalog and grants</b><br/>type, fields, secret:operate"}
  B -- "invalid or denied" --> X["<b>Reject</b><br/>No gateway call"]
  B -- "valid" --> C["<b>Read Secret values</b><br/>SecretDriver.withValue"]
  C --> R["<b>Commit record</b><br/>state registering"]
  R --> D["<b>registerSource</b><br/>Gateway stores copy"]
  D -- "failed or unknown" --> Y["<b>removeSource</b><br/>Delete record, or keep it deleting"]
  D -- "ready or pending" --> E["<b>Mark ready</b><br/>with audit"]
  E --> F["<b>Bind to Agent</b><br/>actor operate"]
  F --> G{"<b>deployAgent</b><br/>gateway, Sandbox, both grants"}
  G -- "Secret-backed method" --> Z["<b>409 conflict</b><br/>No env fallback"]
  G -- "admitted" --> H["<b>Freeze snapshot</b><br/>sourceId, gateway, type, loginMode"]
  H --> I{"<b>Worker dispatch</b><br/>grants and live record"}
  I -- "mismatch or unavailable" --> W["<b>Permanent failure</b><br/>Revision stays inactive"]
  I -- "ready" --> J["<b>Compute receives source</b><br/>Attachment handoff"]
  E --> K["<b>DELETE</b><br/>refused while referenced"]
  K --> L["<b>Mark deleting</b><br/>then removeSource"]
  L -- "gateway failure" --> M["<b>503</b><br/>Record stays deleting"]
  L -- "removed" --> N["<b>Delete record</b><br/>Namespace may empty"]
```

## Execution Trace

Registration and deletion reject an active or stale inherited controller
transaction with `ResourceConflictError` before effects. OCC commits the
intermediate State record before calling `registerSource` or `removeSource`.

### 1. Admit the registration request

`apps/controller/src/http/credential-sources.ts:createCredentialSource`,
`packages/occ/src/index.ts:createCredentialSource`

The route accepts `name`, `type`, optional `config`, and lowercase `secrets`
fields. In one transaction, OCC locks the Namespace, authorizes
`credential_source:create`, returns
`409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` when the Installation selects no
Credential Gateway, and requires a `ready` Namespace. It asks the selected gateway for `listSourceTypes` and rejects an
unknown type, an unknown field, or a missing required field with
`ScopeViolationError` (`404`). It then calls the Driver's side-effect-free
`validateSourceConfig`. Invalid values return `CredentialSourceConfigError`
(`400 INVALID_REQUEST`) before any Secret read, record creation, or gateway write.
The shared `apps/controller/src/drivers/openai-endpoint.ts:normalizeOpenAiBaseUrl`
parses URLs before rejecting wildcard hostnames (including decoded percent
escapes), wildcard paths, and port `0`. OpenShell additionally uses
`apps/controller/src/drivers/credential-gateway/openshell.ts:normalizedSourceBaseUrl`
to reject bracketed IPv6 hosts: its profile matcher interprets brackets as
character classes, not literal URI syntax. Compute URL validation still accepts
IPv6. Registration and attachment require the OpenShell-safe representation;
status and deletion retain the no-guessed-owner behavior for invalid stored sources.

### 2. Read Secret values

`packages/occ/src/index.ts:createCredentialSource`

OCC first rejects any Secret reference to another Namespace with
`SecretBindingValidationError` (`400 INVALID_REQUEST`, "Credential source
Secrets cannot cross Namespaces."). For each Secret reference, it then authorizes
`secret:operate`, locks the Secret (a Secret the Namespace does not hold is
`404`), and calls the owning Driver's optional
`withValue`. The Kubernetes Secret Driver verifies the stored object's ownership
labels, UID, and key before decoding it. A Driver without `withValue` returns `503`. Values remain in memory for the gateway call.

### 3. Register with the gateway and commit

`packages/occ/src/index.ts:createCredentialSource`,
`packages/occ/src/index.ts:abandonCredentialRegistration`,
`apps/controller/src/drivers/credential-gateway/openshell.ts:registerSource`

The transaction inserts a `registering` `credential_sources` row with a new
`cs_` ID and gateway Driver ID, plus `credential_source_secrets` rows. The
OpenShell provider name derives from that ID. Compute's `resolveSandboxNamespace`
supplies the paired Sandbox's runtime placement. OCC calls `registerSource` with
a 30-second timeout; the Driver ensures the Workspace profile and creates an
OCC-labeled provider with that `profile_workspace`. Retries adopt only matching labels.

For terminal `failed` or `absent` results, `abandonCredentialRegistration`
removes the provider and record, retaining a `deleting` record if removal fails.
Thrown calls always retain `deleting` after cleanup: a timed-out create may still
land, requiring another DELETE. Success commits `ready` and the mutation audit
together. A failed commit or process exit leaves `registering`, ineligible for
binding or admission but deletable. If concurrent DELETE already removed the
record, OCC repeats remote removal and returns `409`.

### 4. Bind the source to an Agent

`packages/occ/src/index.ts:authorizeHarnessAuthSource`

PATCH first authorizes `credential_source:operate` on each already-bound
source, without a lookup (`authorizeBoundCredentialSources`), so an
update can drop sources after a gateway change. Create and PATCH then authorize
`operate` on each requested source; before any lookup, an Installation without
a Credential Gateway fails with `CredentialGatewayNotConfiguredError` (`409`),
so the answer never depends on whether the source exists. The source must be
`ready` in the exact Namespace and owned by the selected gateway. The generated
`agents.harness_auth_credential_source_id` column references the source, so the
database rejects deleting a source an Agent draft still uses.

Every entry of `credentialSources` follows the same checks
(`packages/occ/src/index.ts:authorizeAgentCredentialSources`), which also
requires a credential-source `harnessAuth` to name a listed entry
(`assertHarnessSourceListed`, `AgentCredentialSourceBindingError`, `400`). That
rule runs after every source check, so a caller without `operate` gets `403`
first. The list is stored in
`agents.credential_sources`; the constraint
`agents_harness_credential_source_listed` enforces the same rule, and the trigger
`agent_credential_sources_are_synchronized` mirrors the list into
`agent_credential_sources`, whose foreign key restricts source deletion.

### 5. Admit the deployment

`packages/occ/src/index.ts:deployAgent`, `packages/occ/src/index.ts:admitHarnessAuth`

`assertCredentialGatewayDelivery` rejects `api_key` and both sources of
`codex_pat` with `409` while a gateway is selected. For
`credential_source`, `admitHarnessAuth` authorizes the Agent service principal's
`operate`, requires a `ready` source, and reads its catalog type, which must
declare `harnessAuth`. The frozen snapshot is `{ method, sourceId,
credentialGatewayId, sourceType, loginMode }`. `admittedCredentialSourceType`
requires a selected Sandbox, and Compute `validateHarnessAuth` requires
a dedicated Codex or native OpenClaw Harness, the paired Sandbox and gateway,
and an `openai`/`api_key` type. Compute renders no model Secret for either
Harness and passes the resolved source to Sandbox provisioning.
`admitCredentialSources` refuses a list without a selected Sandbox Driver
(`409` with its message), rechecks the caller's binding grants, then authorizes
the Agent principal's `operate` on every listed source, including the Harness source, checks each type against the
catalog, and freezes `{ sourceId, credentialGatewayId, sourceType }` entries in
the revision's `credential_sources`.

### 6. Resolve the source at dispatch

`apps/controller/src/worker.ts:authorizeRevision`,
`apps/controller/src/worker.ts:resolveRevisionSecretContext`

The worker rechecks `credential_source:operate` for the deploying actor and the
service principal; a denial ends the work item with `AUTHORIZATION_DENIED`. It
then compares the snapshot's gateway ID with its selected Driver
(`CREDENTIAL_GATEWAY_MISMATCH` on a difference) and loads the current record. A
missing or `deleting` source, or one whose Driver or type differs, returns
`HARNESS_AUTH_SOURCE_UNAVAILABLE`. Otherwise it passes the snapshot plus the
record to Compute, which rechecks the match in `harnessAuthForRevision`. It
loads each other listed source the same way, skips the Harness source and any
source withdrawn from the revision, and returns `CREDENTIAL_SOURCE_UNAVAILABLE`
for one that is missing or changed.
Compute checks the list in `credentialSourcesForRevision` and attaches it after
the model source. The next owner is the [OpenShell Sandbox provisioning flow](openshell-sandbox-provisioning.md#2-derive-the-provider-owned-harness-request).

### 7. Delete the source

`packages/occ/src/index.ts:deleteCredentialSource`,
`apps/controller/src/drivers/credential-gateway/openshell.ts:removeSource`

OCC authorizes `delete`, requires a selected gateway (`409`), and locks the
source. It returns `409` for draft, active-revision, or pending-deployment
references, or `503` if another driver registered it. Only then does it commit
`deleting`; database triggers prevent backward transitions. The Driver removes
the owned provider, confirms absence, then deletes its profile after the last
user. Invalid endpoints permit no profile removal and succeed only if the provider
is absent. Unverifiable ownership, unknown type, or gateway read failure never
counts as absence; failures return `503`, retaining `deleting`.

Even successful removal retains the record with `503` until
`CREDENTIAL_REGISTRATION_FENCE_MS` (70 seconds) after `createdAt`: registration
effects must finish within 30 seconds of abort, and Backend calls have 30-second
deadlines. The final transaction deletes the record and appends its audit;
audit failure leaves `deleting` for retry. Namespace deletion returns
`NAMESPACE_NOT_EMPTY` while any record remains.

### 8. Update a source

`packages/occ/src/index.ts:updateCredentialSource`,
`apps/controller/src/drivers/credential-gateway/openshell.ts:updateSource`

OCC locks the Namespace and source, authorizes `credential_source:update`,
requires `ready`, and validates replacement references against catalog Secret
fields. It authorizes each Secret's `secret:operate` and reads it with `withValue`.
Under the source lock, `updateSource` uses Compute's placement; the OpenShell
Driver requires the owned provider and calls `UpdateProvider`. OCC then commits
replacement references and audit together. Gateway failure rolls back references;
commit failure leaves newer gateway values, converged by repeating the request.
`absent` or `failed` returns `503`. The Driver rejects empty values because
`UpdateProvider` merges values. Only subsequently started processes receive updates.

### 9. Withdraw a source from an Agent

`packages/occ/src/index.ts:withdrawAgentCredentialSource`,
`apps/controller/src/worker.ts:processCredentialWithdrawal`,
`apps/controller/src/drivers/compute/kubernetes/index.ts:withdrawCredentialSource`,
`apps/controller/src/drivers/credential-gateway/openshell.ts:withdraw`

The API authorizes `agent:operate` and requires the active revision to have been
admitted with the source in `credential_sources`. It inserts a `pending` `credential_withdrawals`
row keyed by revision and source, or returns the existing one. Unless
withdrawal work for the revision is already queued or claimed, it makes the
caller `requested_by` and queues revision-scoped work with target `credentials_withdrawn`
(`packages/occ/src/state/controller-work.ts:credentialWithdrawalWorkKey`). That
work has its own idempotency key, never deploys the revision, and owns no
repository cleanup.

The worker loads every pending withdrawal of the revision's sources and rechecks
`agent:operate` for each withdrawal's own `requested_by`, never only the claim's
actor. It calls Compute's `withdrawCredentialSource` for each authorized one in
admission order. The work retries while an authorized withdrawal is unconfirmed;
otherwise a denied requester fails it after the others are revoked. Each
revocation is audited for its requester in the pass that confirms it, and each
denial once when the claim ends. Compute derives the Sandbox with the Sandbox Driver's
`harnessResource` and passes it to the gateway's `withdraw`; the OpenShell
Driver calls `DetachSandboxProvider` and reads the receipt's status. Each
attempt records its reason code in `last_reason` and `last_attempt_at`, in the
transaction that completes, retries, or fails the claim. `revoked` or `absent`
also marks the row `revoked` and appends
`openclaw.agents.lifecycle.credentials_withdraw`. Any other state retries with
backoff until attempts run out; the row then stays `pending`. The API derives
`withdrawalInProgress` from outstanding withdrawal work
(`packages/occ/src/index.ts:readAgentCredentialWithdrawal`), so an exhausted
withdrawal reads `false` even if its claim expired. Only a replay, or maintenance
where it exists, queues another attempt.

Maintenance of the active revision (scheduled only when Compute or repository
credentials declare an interval) checks for a withdrawal before it resolves the
revision's credentials
(`apps/controller/src/worker.ts:completeWithdrawnRevisionMaintenance`). While
any withdrawal is `pending`, including a tool withdrawal after model revocation,
the pass queues withdrawal work if none is outstanding, completes, and keeps the
maintenance chain; once all are `revoked`, it completes without scheduling more.
Deploy and repair work fail with `CREDENTIAL_WITHDRAWN` rather than re-attach a
withdrawn Harness source, and omit any other withdrawn source. Maintenance also
re-queues work for other pending withdrawals
(`apps/controller/src/worker.ts:recoverPendingCredentialWithdrawals`), so a
withdrawal exhausted during a gateway outage resumes after it.
`authorizeRevision` skips the `operate` recheck for withdrawn sources, which never
attach again, so removing their grants cannot end maintenance.

## Debugging and Verification

- `node --test tests/conformance/credential-source-occ.test.mjs` covers catalog
  validation, Secret `operate`, registration compensation, uncertain-registration
  recovery, audit with the final state change, deletion refusal and retry, Namespace gating, admission snapshots, and rejection of Secret-backed
  methods with a gateway selected. It uses an in-process gateway double, not
  OpenShell.
- `node --test tests/integration/credential-source-api.test.mjs` exercises
  Fastify, IAM, OCC, and the OpenShell Driver: invalid endpoint rejection without
  residual records, invalid-row deletion recovery, profile isolation, and custom
  endpoint lifecycle. Gateway storage and Compute placement are test doubles;
  this does not prove OpenShell runtime execution.
- `node --test tests/conformance/openshell-gateway-wire.test.mjs` checks the
  provider, profile, update, and detach RPC encoding against the pinned `v0.1.3-pre.2`
  wire fixture.
- The credential withdrawal cases in
  `tests/integration/postgres-worker-agent-revision.test.mjs` run the real queue
  and worker against PostgreSQL with a Compute double: revocation after a
  pending retry, exhaustion followed by a replay, maintenance of a withdrawn
  revision, a retry that omits two non-model sources revoked in one pass,
  per-requester authorization of a shared claim, another operator's replay,
  maintenance recovery of exhausted or ungranted withdrawals, and dispatch refusal
  after the Agent loses a source grant.
- The real OpenShell test updates the source through the API, withdraws it from
  the running Agent, and checks that the next model turn in that Codex process
  fails. First, a `bearer-token` placeholder sent to an in-cluster echo service
  arrives substituted (digest checked), and withdrawing that source stops
  delivery while model turns continue.
- `OCC_TEST_OPENSHELL_K3D_REAL=1 node --env-file="$TEST_ENV_FILE" --test tests/integration/sandbox-driver-openshell-k3d-real.test.mjs`
  registers an `openai` source through the production API against a real
  gateway and reads its live `ready` status. See [OpenShell tests](../testing/openshell.md).
- A source stuck in `deleting` returns `503` on delete until the gateway is
  reachable; `GET` shows its live `status`.
- Worker reason codes `CREDENTIAL_GATEWAY_MISMATCH` and
  `HARNESS_AUTH_SOURCE_UNAVAILABLE` identify a changed selection or an
  unavailable source; `CREDENTIAL_WITHDRAWN` means the revision's source was
  withdrawn, and `CREDENTIAL_WITHDRAWAL_PENDING` means the gateway has not yet
  confirmed revocation. A withdrawal's `reason` on `GET` is its latest code;
  `CREDENTIALS_WITHDRAWN` and `WITHDRAWAL_REVISION_RETIRED` complete the work,
  and `CREDENTIAL_WITHDRAWAL_UNSUPPORTED`, `COMPUTE_DRIVER_MISMATCH`, and
  `AUTHORIZATION_DENIED` fail it at once.

## Related docs

- [Credential sources](../reference/credential-sources.md)
- [CredentialGatewayDriver contract](../reference/drivers/credential-gateway.md)
- [OpenShell Credential Gateway](../reference/drivers/openshell-credential-gateway.md)
- [Secret storage and delivery](secret-storage-and-delivery.md)
- [OpenShell Sandbox provisioning](openshell-sandbox-provisioning.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-08 11:45: DELETE checks gateway ownership before `deleting`. (fix-811-812 - e461e1621)
- 2026-10-08 11:42: Reconciled binding and withdrawal behavior with endpoint validation; trimmed repeated lifecycle detail. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - 1eceea5dfb864ff469dce04a42fe3cce9c7f5f75)

- 2026-10-08 10:00: Replays take over stranded withdrawals; withdrawn sources skip the grant recheck. (fix-787-788)
- 2026-10-08 09:30: Agent PATCH needs only `operate` on already-bound sources. (fix-782)
- 2026-10-08 09:00: Deploying listed sources without a Sandbox Driver returns `409` with its message, not the generic "already exists". (fix-786)
- 2026-10-08 08:30: Agent binding reports a missing Credential Gateway as `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` and an unlisted Harness source as `400`, after the caller's `operate` checks. (fix-783-784)

- 2026-10-08 04:40: Reconciled OpenAI endpoint validation with the new tool-token source lifecycle. (authoring-run/02228d02-e16c-4a55-9a43-16b9efb35ebe - 31b1b6a9ab59f219d0fbe3d44b1550f8c8f2fe4a)

- 2026-10-07 18:00: Unified binding: one `credentialSources` list holds every source, and a credential-source `harnessAuth` names a listed entry. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - ee950468c)
- 2026-10-07 12:07: Unify imported and managed PAT authentication while preserving source ownership and existing OAuth behavior. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - be5006e62)
- 2026-10-06 21:30: Keep tool-withdrawal recovery scheduled after model revocation without preparing the revision again. (pr-851-rebase - bb6c7449b)
- 2026-10-06 16:12: Reject normalized hostname stars, zero ports, and OpenShell bracket hosts before credential-source persistence. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - 129b9b98812a861cfbdcec386daf5258902ebba8)
- 2026-10-05 11:36: Validate source configuration before persistence and recover invalid rows without guessing remote ownership. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - 9958ef0412565864efba7b13995536d7c2a51d22)

- 2026-10-03 18:00: Registration and update reject a Secret reference to another Namespace as an invalid request instead of not-found, as Secret bindings do. (binding-400b)
- 2026-10-03 16:00: Report `withdrawalInProgress` so an exhausted withdrawal no longer reads as in progress; maintenance re-queues only where it is scheduled. (fix-withdrawal-exhausted)
- 2026-10-02 10:00: Authorized each batched withdrawal by its own requester and recovered pending non-model withdrawals during maintenance. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 92e33389d)

- 2026-10-01 21:30: Added non-model sources bound through `credentialSources`, their admission, dispatch and withdrawal. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 9a202599b)
- 2026-10-01 20:30: Report a missing Credential Gateway as `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` at registration. (fix-d93-d100)
- 2026-10-01 11:37: Updated the OpenShell wire-fixture pin to v0.1.3-pre.2. (authoring-run/f1f395c4-2594-4b07-9e92-ae829a5b5dd4 - f22a584e6ce21d505b40a72fdb5ae1c6e74c1c84)
- 2026-09-30 21:14: Updated the independent OpenShell wire-contract verification pointer to v0.1.3-pre.1. (authoring-run/b158c89c-3010-42ae-95b4-350b05de7441 - 37bbee705ea3808ad000413dd54bdcc718980179)

- 2026-09-30 04:00: Recorded withdrawal attempt reasons, replay deduplication, and maintenance of a withdrawn revision; corrected the update ordering. (pr-553-alignment - 3a5e48035)
- 2026-09-28 18:00: Added source update and per-Agent withdrawal through worker-executed revocation. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 7cd4a210)
- 2026-09-28 05:13: Documented the controller transaction boundary for credential source writes. (authoring-run/5da74b2e-b249-44da-87e4-ca85f018c832 - 646b067220f6b7f8f3059eaa0710db2654b61499)
- 2026-09-27 22:51: Extended credential-source Harness delivery to dedicated native OpenClaw without projecting the model Secret. (authoring-run/88764ea7-c6bb-4ac8-919f-c21071946c37 - 859c0b11e5f1c350acda231c89ad3573504324eb)
- 2026-09-26 14:29: Documented credential source registration, Agent binding, admission, dispatch resolution, and retried deletion for the uncommitted Credential Gateway change. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 849b2b24111fe237b12da5be1d4b411d3146cefb)
