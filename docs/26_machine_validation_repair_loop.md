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

## Evidence-aware handoff

An author could declare a downstream handoff with a contact sheet still marked
`change_requested`. The author stopped, while the recipient could not consume its
input. The loop now walks the active artifact dependency graph (including indirect
consumers), rejects incomplete downstream handoffs, and returns exact output IDs,
paths and statuses to the original task. Feedback replaces a bounded task-context
section, because transient agent `lastError` is cleared when the next worker starts.
Three failed attempts stop; successful submission removes the repair section.
Upstream/producer requests, explicit blockers and invalid upstream inputs retain
their existing handling. No files or review verdicts are fabricated by recovery.

When work is blocked, unrelated completed reviews no longer turn the whole loop
into “waiting for producer”. The UI receives the actual unresolved work reason.
Regression: `node scripts/verify-handoff-evidence.mjs` after `npm run build`.

## Cocos tool contracts and failed-operation diagnostics

The scene tool used to advertise any name under `assets/scenes`, while its worker
was authorized for `MainGame.scene` only. The bridge, authorization builder and
tool default now share a constant; the schema advertises the actual granted
paths. This does not grant generic scene writes or arbitrary directory access.

Cocos failures intentionally write operation reports. Treating those reports as
unauthorized partial mutations rolled back earlier successful imports in the same
isolated invocation. Exact, hash-bound server diagnostics are now retained on disk
with failed tool records, without adding them to required outputs or the artifact
ledger. Failed builds remain unconsumable. Any failed source/scene/asset mutation,
wrong operation identity, altered report bytes or unauthorized path still rejects
publication. Regression: `node scripts/verify-cocos-failure-diagnostics.mjs`.

## Telemetry is not a durable transaction

Each streamed model delta previously triggered three full workspace syncs, evidence
reconciliation and a complete snapshot save. A long project history amplified this
into sustained API CPU saturation during otherwise ordinary asset import progress.
Activity reporters now update in-memory UI state without that transaction. The
existing task-start, result-publication, pause and settlement checkpoints remain;
producer intent is explicitly persisted before requesting a room model response.
Active progress may be lost after a crash (and is cleared at restart already), but
committed artifacts, decisions and final activity timelines retain their durable
boundaries. Regression: `node scripts/verify-activity-checkpoints.mjs` verifies 200
progress events without intermediate durable saves, plus producer-input durability.

## Native Creator import side effects

The first real Creator build succeeded but was rejected on publication because
Creator emitted `.meta` files across `assets`, updated `package.json`, and created
editor profiles/settings outside the agent's write grants. Broadening the role's
source-write permissions would erase the isolation boundary. Instead, both WeChat
and QA web builds snapshot the narrowly defined editor metadata/configuration just
before native Creator execution and restore it in `finally`. Built files, logs and
reports remain available; prior authored metadata/configuration retain exact bytes.
Unexpected source/asset changes remain visible to the outer workspace guard and
are still rejected. Symlinks are refused. This deliberately favors reproducible,
isolated builds over caching generated editor metadata in the authored workspace.
Regression: `node scripts/verify-cocos-build-isolation.mjs`.

Project-list polling also reloaded complete on-disk audit histories (one observed
request took 18 seconds). The single-process store now keeps a small summary
projection from successful durable saves, including real `savedAt` timestamps.
Creation, lazy loading and deletion maintain that projection; callers receive
copies. This is not a cross-process cache-coherence or database replacement.

## Build aggregate versus supporting evidence

Every changed file under a directory build used to re-register the same build
artifact. A bundle after `build-report.json` could replace its import/manifest
metadata with no receipt. All validated files are still committed atomically, but
only the canonical report registers the aggregate build evidence. Hash/manifest
checks on the entire output and current import receipt remain mandatory.

Historical bridge operation reports, imported runtime copies and generated bridge
files retain their provenance as supporting evidence; they are not new promised
deliverables of the build task. A narrow migration removes these bridge-managed
paths from its required output list without deleting files/history or approving old
statuses. Workspace synchronization preserves that distinction. The canonical
build remains mandatory. Regression coverage is in `verify-cocos-engine-bridge.mjs`.

Normal native rebuilds replace old hashed chunks. The guard now allows deletion
only inside the current task's registered build directory when a successful,
byte-bound `cocos_build` report and its full new directory manifest validate.
Failed/missing/tampered receipts never authorize replacement, nor does a successful
build authorize any source/asset deletion. The workspace transaction backs up each
obsolete build file before removing it and restores deletions along with writes if
publication fails. Original authored assets and code are unaffected. This is build
replacement, not a general agent delete capability or permanent version archive.
Tests: `verify-cocos-engine-bridge.mjs` and `verify-workspace-isolation.mjs`.

## QA launch failures are evidence, not permission violations

The QA service builds a separate `web-desktop` target, not the WeChat bundle.
Previously, browser startup failures dropped console logs and the nested build's
file receipts. The outer guard then rejected those unaccounted service writes;
the QA agent could only see a timeout and incorrectly inferred a WeChat/browser
platform mismatch. Startup failures now retain the actual target, launch phase,
console errors, page screenshot (when possible), result JSON and nested build
receipts. A loaded scene with a missing runtime adapter routes to the programmer;
build/browser/scene startup failures remain with automation for diagnosis.

Only byte-matching `run_playtest` operations backed by a verified QA receipt may
publish their own operation's Web directory and exact build log/report paths.
Arbitrary writes, source mutations, foreign operation IDs and missing/tampered
receipts remain rejected. Build bundles stay in the receipt rather than becoming
hundreds of required QA deliverables; screenshots/logs are supporting evidence.
Creator's native scene reserialization is restored alongside editor metadata,
so a QA build does not silently edit the canonical authored scene.

Tests: `verify-qa-launch-diagnostics.mjs`, `verify-staged-qa-receipts.mjs`,
`verify-cocos-build-isolation.mjs`, `verify-qa-playtest-gate.mjs`.

Producer change requests can target `[task:task_stage_2_qa_playtest]` (or an
explicit related-task binding). Exact task selections take precedence over role
mentions; unknown IDs do not fall back to reopening all of a role's work. Normal
downstream invalidation still applies. Use this for a specific QA retry instead
of reopening its contract authoring and independent review tasks as well.
An implementation review explicitly marked `change_requested` cannot complete
from an unchanged previous receipt; a newly submitted grounded negative verdict
still completes independent reviewer work without approving the implementation.

## Native scene identity and immutable QA history

Real QA captured a corrupted Canvas component: the generated scene serialized
the bootstrap's compressed script UUID, but the headless compiler registered the
class by its name without a UUID `_RF` frame. The generator now registers the
exact serialized identifier through Cocos `js.setClassAlias`, retaining its
primary identity. The generated-module regression executes both compiler modes;
real startup still requires the independent QA run. See Cocos' official
[class serialization documentation](https://docs.cocos.com/creator/3.4/manual/zh/scripting/ccclass.html)
and the installed 3.8.8 engine's `js-typed.ts` alias implementation.

Workspace synchronization no longer re-materializes receipt-ingested QA reports
and evidence. Those bytes and their input provenance describe the historical
run. Recapturing inputs after QA invalidates a build for repair previously threw
and terminated the API; it could also rebind old evidence to a different build.
Only a fresh trusted QA execution/receipt may publish new execution evidence.

An authoritative staged diff also preserves explicit idempotent text/source
submissions: a completed write operation with matching SHA-256/size for the
current task's owned registered file counts even if its bytes did not change.
File existence, read operations, failed writes and mismatching hashes do not.
This permits a justified unchanged-source resubmission after a platform-only
repair, without requiring pointless gameplay edits or skipping fresh independent
checks. Directory builds and protected QA/media outputs retain their own service
receipt requirements. Regression: `verify-claude-harness.mjs`.

For programmer tasks, `resubmit_source(path, expectedHash, reason)` avoids sending
an unchanged multi-thousand-line module back through the model. It accepts only
the task's owned registered TypeScript source, never generated bridge code or
self-check/QA reports. The server verifies the current full-file hash and records
the explicit reason without editing bytes; fresh self-check and independent QA
requirements remain. Regression: `verify-implementation-review.mjs`.

The same idempotency rule includes the programmer's exact server-owned self-check
path when `run_implementation_checks` actually reruns and records matching bytes.
Deterministic reports need not invent timestamps or change content to count as a
new verified execution. Direct writes to that report remain forbidden.
