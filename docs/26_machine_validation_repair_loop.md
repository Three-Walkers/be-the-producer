# Machine validation must produce actionable author work

## Failure observed in Tidewatch

The visual reviewer reported a passing score while a runtime PNG declared
`alphaPolicy=required` had minimum alpha `254/255`. The deterministic gate was
correct to reject it, but repeatedly scheduling the reviewer did not repair the
image. The asset role could also stop at an inferred “wait for producer approval”
despite incomplete outputs. Neither a score nor a chat claim is build evidence.

## Repair routing

`reconcileAssetTechnicalFailures` runs during checkpoint reconciliation and lazy
loading. It checks active asset-production manifests and their actual runtime PNG
bytes, collecting all schema, missing-file, decoding and alpha-policy failures.

- A failed manifest is `change_requested`; reviewers/builders cannot consume it.
- The original asset-owning task receives exact paths, SHA-256 and measured
  failures in a bounded replacement section of its description.
- A server message makes the same diagnostic visible in the art room.
- Retry exhaustion and an agent's stale stage-approval wait can be cleared once
  for new actionable evidence. Manual/access/dependency blockers are preserved.
- Failure fingerprints use failing paths, policies and actual bytes. Cosmetic
  manifest version bumps cannot generate an infinite retry/message storm.
- Immutable server messages record dispatch and recovery across restarts.
- Cancelled and previous-stage tasks are not reopened. Project pause and real
  workflow approvals remain independent constraints.
- A technical recovery does not approve the manifest or visual review. Authors
  must resubmit current outputs, reviewers must inspect current pixels, and QA
  must run a real Cocos build.

## Generation-time guard and validation cost

Review-task completion and downstream readiness are separate predicates. A
grounded `change_requested` review completes reviewer work and survives
checkpoint reconciliation, but cannot satisfy a builder's input. Only a current,
valid `pass` review is consumable downstream; actual producer gates remain strict.

`remove_white` now checks the final PNG for usable transparency before returning
it to the generation tool for publication. No removed background, near-opaque
noise, or a wholly invisible image returns an actionable error, not success.
Existing genuine alpha is allowed; internal white highlights remain preserved.

PNG alpha measurements use a bounded 256-entry content-hash LRU. Current bytes
are always read and hashed; policies are always evaluated anew. Returned objects
are copied, errors are not cached, and image buffers are not retained. Path or
mtime reuse cannot turn changed content into a cached acceptance.

## Regression coverage

Run `npm run build`, then:

- `node scripts/verify-image-asset-alpha.mjs`
- `node scripts/verify-raster-normalization.mjs`
- `node scripts/verify-quality-gate-and-assets.mjs`
- `node scripts/verify-store-evidence-reconciliation.mjs`
- `node scripts/verify-agent-loop.mjs`

These changes repair the production mechanism. They do not establish that
Tidewatch has a runnable build or that its gameplay has passed QA.

## Follow-up failures observed during the same run

- QA receipt ingestion used to classify tasks only by owner. A closed claim
  repair has no `qa_report`, so it was reopened for missing playtest evidence,
  closed again by claim reconciliation, and repeatedly queued through microtasks.
  This could saturate the API thread without running a worker. Ingestion now
  targets only actual, task-owned `qa_report` execution work, not contract
  authoring, implementation reviews, task groups or closed claim repairs.
- A reviewer could submit a contact sheet plus an incomplete set of runtime
  images. Submission now checks every runtime hash in the server-owned manifest
  context and names missing images before writing the report. The same invocation
  can inspect those images and resubmit without losing its prior observations.
- Invalidated review evidence combined with a late handoff could leave a reviewer
  blocked after the author had repaired its inputs. A fingerprinted recovery
  requeues that reviewer once per verified input revision, preserves manual
  blockers, and does not manufacture a valid review receipt.
- Positive `note` findings inside a failed aggregate criterion stay in the
  evidence but are not converted into required author changes. Invalid manual
  review JSON immediately points the reviewer to `submit_visual_review` instead
  of encouraging repeated score/field transcription.

Additional regression commands: `verify-qa-playtest-gate.mjs`,
`verify-harness-mcp-authorization.mjs`, and `verify-vision-semantic-binding.mjs`
under `scripts/` (after `npm run build`).
