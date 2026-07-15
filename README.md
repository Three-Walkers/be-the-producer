# Be The Producer

**English** | [简体中文](./README_zh.md)

Be The Producer exists to simplify game creation. Anyone with a game idea can act as the producer, even when that idea is unvalidated, incomplete, or still only a rough direction.

The product turns an early idea into a transparent production process. The producer does not need to start with a complete design document, a full development team, or professional game-production experience. They bring the initial spark, review key milestones, make product decisions, and guide the work as the AI game studio turns the idea into a playable game.

Be The Producer is an AI-powered virtual game studio product system and implementation workspace. The system takes a producer's initial game idea plus controlled server access, then coordinates specialized agents across planning, art, engineering, QA, release, and live operations to deliver a production-ready WeChat mini-game.

The initial product scope is lightweight WeChat mini-games built with Cocos Creator, not large-scale PC or console games.

## Product Goal

The final user experience is:

1. The producer provides a game idea, even if the idea is still vague.
2. The system opens a multi-agent studio room where planning and art agents clarify the concept with the producer.
3. Agents generate and maintain game design, art direction, task plans, source code, assets, tests, build logs, deployment records, and iteration plans.
4. At each key production gate, the producer reviews the work and gives feedback.
5. The agents adjust the plan, assets, gameplay, code, tests, and deployment based on the producer's decisions.
6. The system ships a playable WeChat mini-game and keeps the project ready for live-ops iterations.

The producer is not a passive requester. The producer is part of the production process and has continuous authority to ask questions, approve gates, reject deliverables, and redirect the project.

## Core Principle

Game development is visible, traceable, and role-driven.

This system is not a single black-box chatbot that generates a pile of code. It operates as a small game studio where each role has its own responsibility, workspace, deliverables, and accountability trail.

## Target Inputs and Outputs

### Inputs

- Game idea or "ideal" from the producer.
- Optional references such as genre, theme, art style, comparable games, target audience, monetization assumptions, or platform constraints.
- Server or cloud access credentials, stored through a controlled secret mechanism.
- Producer feedback during milestone reviews.

### Outputs

- Game Design Document (GDD).
- Art Bible and asset production plan.
- Runtime-ready 2D assets, UI assets, animations, audio references, and asset manifest.
- Cocos Creator project.
- TypeScript gameplay implementation.
- WeChat mini-game build.
- QA playtest reports, bug reports, screenshots, recordings, and release gate reports.
- Deployment plan, deployment record, rollback plan, and live-ops iteration backlog.
- Structured production memory covering project state, producer decisions, role progress, artifacts, QA results, releases, and reusable game-development knowledge.

## Multi-Agent Studio Model

The product is organized as a role-based multi-agent studio. Each agent owns a clear part of the pipeline.

| Agent | Main Responsibility | Typical Deliverables |
| --- | --- | --- |
| Studio Orchestrator | Controls workflow state, routing, task creation, phase gates, and cross-agent coordination. | Stage plan, task graph, decision requests, project status. |
| Producer Agent | Converts producer intent into scope, schedule, risks, and milestone reviews. | Production plan, backlog, risk log, review agenda, decision log. |
| Game Designer Agent | Designs core loop, rules, progression, levels, balance, and player goals. | GDD, core loop spec, level specs, economy and balance specs. |
| Art Director Agent | Defines visual style, UI direction, readability rules, color palette, animation tone, and asset quality bar. | Art Bible, style board, UI visual spec, asset review notes. |
| Asset Production Agent | Produces, normalizes, packages, and version-controls game assets. | Sprites, UI assets, sprite sheets, animation strips, asset manifest. |
| Cocos Tech Lead Agent | Owns Cocos architecture, scene structure, prefab strategy, asset loading, performance budget, and technical standards. | Technical design, scene blueprint, module plan, performance checklist. |
| Gameplay Programmer Agent | Implements game systems, UI logic, gameplay rules, data loading, and integration code. | TypeScript code, Cocos components, implementation notes, code change log. |
| Cocos Automation Agent | Operates Cocos through an engine bridge or MCP layer. | Scene operations, prefab updates, asset imports, build logs, editor snapshots. |
| Game Evaluator / QA Agent | Evaluates the actual game experience, not only unit tests. | Playtest reports, visual QA, bug reports, release gate assessment. |
| WeChat Platform Agent | Handles WeChat mini-game packaging, platform constraints, preview, upload, and platform readiness. | WeChat build config, preview package, upload report, package-size report. |
| DevOps Agent | Handles server deployment, environment setup, logs, rollback, and production readiness. | Deployment plan, release record, rollback plan, server health report. |
| LiveOps / Analytics Agent | Tracks post-release data and plans continuous improvement. | Analytics plan, event schema, iteration backlog, tuning plans. |

## Human-in-the-Loop Production

The producer is involved at key points. The system explicitly requests decisions instead of silently making product-defining choices.

Examples of required producer review points:

- Game concept confirmation.
- Core gameplay and scope approval.
- Art direction approval.
- First playable review.
- Content and difficulty review.
- QA release gate review.
- Production deployment approval.
- Post-release iteration priority review.

Producer feedback is first-class project data. Every accepted or rejected decision is saved with timestamp, requester, affected artifacts, and follow-up tasks.

## Studio Chat Rooms

The collaboration space is a studio group chat with role-aware routing.

Studio rooms:

| Room | Purpose |
| --- | --- |
| `#studio-main` | Main producer room, milestone status, decision requests, and cross-role summaries. |
| `#design-room` | Game rules, GDD, levels, progression, balance, and product discussions. |
| `#art-room` | Art direction, asset list, production status, and asset reviews. |
| `#engineering-room` | Cocos architecture, gameplay code, scene integration, and build issues. |
| `#qa-room` | Playtests, bugs, reproduction steps, recordings, screenshots, and release gates. |
| `#release-room` | WeChat build, server deployment, rollback, logs, and production readiness. |

When the producer asks a question in a room, each agent decides whether the question concerns its role. Relevant agents must respond. Irrelevant agents stay silent unless the Orchestrator asks for a summary.

### Message Types

Messages use structured types so the system can route, index, audit, and visualize work.

- `plan_submission`
- `decision_request`
- `decision_record`
- `progress_update`
- `deliverable`
- `review`
- `change_request`
- `asset_review`
- `bug_report`
- `qa_failure`
- `playtest_summary`
- `build_failure`
- `release_gate`
- `deployment_record`
- `blocker`
- `handoff`

## Three-Stage Production Pipeline

```mermaid
flowchart LR
    A["Stage 1: Concept, Mechanism, and Worldview"] --> B["Producer Review Gate"]
    B --> C["Stage 2: Production and Playable Implementation"]
    C --> D["First Playable / QA Gate"]
    D --> E["Stage 3: Release, Operations, and Iteration"]
    E --> F["LiveOps Feedback Loop"]
    F --> C
```

### Stage 1: Concept, Mechanism, and Worldview

This stage handles the early ambiguity of the producer's idea. The producer may only provide a vague direction, so the system must guide the conversation.

Primary agents:

- Game Designer Agent.
- Producer Agent.
- Art Director Agent, lightly involved.
- Studio Orchestrator.

Main tasks:

- Clarify target platform and player session length.
- Define genre, core loop, win and fail conditions.
- Define player fantasy, theme, worldview, and tone.
- Create initial GDD.
- Create early art direction and reference board.
- Define scope for the first playable.
- Request producer approval before development starts.

Exit criteria:

- Approved core loop.
- Approved project scope.
- Approved GDD baseline.
- Approved art direction.
- Initial backlog and milestone plan.

### Stage 2: Production and Playable Implementation

This stage turns the approved concept into a playable Cocos mini-game. Art starts early, while engineering and QA work in parallel.

Primary agents:

- Art Director Agent.
- Asset Production Agent.
- Cocos Tech Lead Agent.
- Gameplay Programmer Agent.
- Cocos Automation Agent.
- Game Evaluator / QA Agent.
- Producer Agent.

Main tasks:

- Produce and normalize art assets.
- Import assets into Cocos.
- Implement gameplay logic and UI.
- Build scenes and prefabs through a controlled Cocos engine bridge.
- Run automated smoke checks.
- Run playtest evaluation.
- Fix gameplay, visual, and integration issues.
- Prepare first playable review for the producer.

Exit criteria:

- Playable core loop.
- No critical runtime errors.
- Art assets integrated and traceable.
- QA report completed.
- Producer accepts the first playable or submits change requests.

### Stage 3: Release, Operations, and Continuous Iteration

This stage prepares the game for production and keeps it ready for later improvement.

Primary agents:

- Producer Agent.
- Game Designer Agent.
- Gameplay Programmer Agent.
- Game Evaluator / QA Agent.
- WeChat Platform Agent.
- DevOps Agent.
- LiveOps / Analytics Agent.

Main tasks:

- Build WeChat mini-game package.
- Check platform constraints such as package size, loading behavior, and resource strategy.
- Deploy backend or static resources when needed.
- Store release notes and rollback plan.
- Run production readiness gate.
- Publish or prepare upload package.
- Collect analytics and feedback after release.
- Convert feedback into an iteration backlog.

Exit criteria:

- Release build generated.
- Deployment record completed.
- Rollback plan exists.
- Release gate report passed or explicitly waived by the producer.
- LiveOps iteration backlog created.

## Role Workspaces

Each agent keeps its own workspace. This gives the producer and maintainers a white-box view of the full development process.

Project layout:

```text
/studio/projects/{game_id}/
  shared/
    memory/
      project-memory.jsonl
      producer-preferences.md
      knowledge-base/
      vector-index-metadata.json
    decisions/
    milestones/
    build-artifacts/
    release-notes/

  agents/
    producer/
      workspace-summary.md
      backlog.md
      sprint-plan.md
      risk-log.md
      decision-log.md

    design/
      workspace-summary.md
      gdd/
      core-loop.md
      level-specs/
      balance-specs/
      change-requests/

    art/
      workspace-summary.md
      art-bible.md
      asset-specs/
      raw-assets/
      processed-assets/
      sprite-sheets/
      asset-manifest.json
      review-notes.md

    engineering/
      workspace-summary.md
      tech-spec.md
      cocos-scene-blueprints/
      implementation-notes/
      code-change-log.md

    cocos-automation/
      workspace-summary.md
      scene-ops/
      prefab-ops/
      editor-snapshots/
      cocos-build-logs/

    qa/
      workspace-summary.md
      test-plans/
      playtest-reports/
      screenshots/
      recordings/
      bug-reports/
      release-gate-reports/

    devops/
      workspace-summary.md
      deploy-plans/
      server-logs-redacted/
      rollback-plans/
      deployment-reports/
```

## Production Memory System

The memory system is a production memory layer for game projects. It is not a generic chatbot memory or agent personality store. It preserves the facts, decisions, responsibilities, artifacts, and lessons required for end-to-end game delivery and continuous iteration.

Memory scopes:

| Memory Scope | Content | Product Function |
| --- | --- | --- |
| Project Memory | Project goal, approved scope, current stage, milestone state, global blockers, active release target. | Gives every agent the same source of truth for project status. |
| Role Memory | Agent responsibilities, assigned tasks, workspace summary, handoffs, blocked items, delivered artifacts. | Lets the producer ask progress questions at any time and receive role-specific answers. |
| Decision Memory | Producer approvals, rejections, waivers, change requests, affected artifacts, follow-up tasks. | Prevents agents from reviving rejected ideas or overwriting approved direction. |
| Artifact Memory | GDD, Art Bible, asset manifests, scene blueprints, code changes, build outputs, deployment records. | Connects every deliverable to its owner, task, stage, and decision history. |
| QA Memory | Test plans, playtest reports, screenshots, recordings, bug reports, release gates, verification status. | Turns QA into a persistent game-evaluation history instead of one-off test output. |
| Release and LiveOps Memory | Release notes, deployment state, rollback records, analytics plans, iteration backlog, tuning history. | Keeps the product ready for ongoing operation and future updates. |
| Producer Preference Memory | Explicit producer preferences, style constraints, rejected patterns, approval habits, review comments. | Preserves the producer's creative direction across sessions and iterations. |
| Knowledge Memory | Reusable Cocos, WeChat mini-game, asset, QA, and deployment lessons extracted from completed work. | Converts project experience into reusable production knowledge. |

Memory status values:

- `draft`
- `active`
- `superseded`
- `rejected`
- `archived`

Only confirmed project facts enter durable memory. Draft ideas stay marked as `draft`; producer-rejected content is marked as `rejected`; replaced decisions are marked as `superseded`. Agents retrieve memory by status and source instead of treating all previous chat as truth.

Memory record schema:

```json
{
  "memory_id": "mem_...",
  "project_id": "game_...",
  "stage_id": "stage_1",
  "scope": "project",
  "owner_agent": "game_designer",
  "type": "decision",
  "status": "active",
  "content": "The approved core loop is a 60-second click-defense session.",
  "source_event_id": "evt_...",
  "source_artifact": "shared/decisions/decision-004.md",
  "created_at": "2026-07-15T00:00:00Z",
  "updated_at": "2026-07-15T00:00:00Z"
}
```

Agent context injection uses structured memory packs:

- Project brief.
- Current stage snapshot.
- Active producer decisions.
- Role workspace summary.
- Open tasks and blockers.
- Relevant artifacts.
- Recent audit events.
- Release or QA gate state.

Vector search is an auxiliary retrieval layer over artifacts, decisions, reports, and knowledge entries. Structured records remain the source of truth. Raw credentials, passwords, tokens, private keys, and secret server access data never enter memory; they remain in the Secret Vault.

## White-Box Traceability

Every important action is written to an append-only audit log.

Audit event schema:

```json
{
  "event_id": "evt_...",
  "timestamp": "2026-07-15T00:00:00Z",
  "project_id": "game_...",
  "stage_id": "stage_2",
  "agent_id": "qa_agent",
  "task_id": "task_...",
  "action_type": "playtest_summary",
  "input_artifacts": ["gdd/core-loop.md", "builds/wechat/dev"],
  "output_artifacts": ["agents/qa/playtest-reports/report-001.md"],
  "tool_calls": ["browser_playtest", "screenshot_capture"],
  "git_commit_or_patch": "abc1234",
  "decision_refs": ["decision-004"],
  "status": "completed",
  "failure_reason": null
}
```

Traceability requirements:

- Art assets must be saved under the art workspace with source, generated version, processed version, and manifest entry.
- QA must save test plans, playtest results, screenshots, recordings, and bug reports.
- Engineering changes must be connected to tasks, commits, or patches.
- Deployment actions must save logs with secrets redacted.
- Producer decisions must be linked to the artifacts and tasks they affect.

## Cocos and WeChat Mini-Game Integration

The engine layer is not a loose collection of generated files. It is a controlled bridge between agents and Cocos Creator.

Engine integration contract:

- Cocos Creator 3.8 LTS is the target engine.
- TypeScript is the gameplay implementation language.
- Scenes and prefabs are represented through structured intermediate files such as `SceneBlueprint.json`.
- The Cocos Automation Agent applies blueprints through an engine bridge or MCP server.
- Complex `.scene` and `.prefab` serialized files are updated through controlled tools.
- Command-line build automation produces WeChat mini-game packages.
- Build logs and editor operation logs are stored in the Cocos automation workspace.

Engine bridge capabilities:

- Open or validate a Cocos project.
- Import and index assets.
- Query scene graph.
- Apply scene blueprint.
- Create or update prefabs.
- Generate and compile scripts.
- Run Cocos build.
- Export WeChat mini-game package.
- Capture editor or runtime snapshots.

## Evaluation and Release Gates

The QA agent represents game product evaluation, not only test execution.

The internal benchmark is `Cocos MiniGame Bench`, because there is no mature public benchmark that fully covers Cocos Creator, WeChat mini-games, multi-agent production, assets, gameplay, and deployment.

Evaluation dimensions:

| Dimension | What It Measures |
| --- | --- |
| Artifact Completeness | Whether all required game, art, QA, and release artifacts exist. |
| Build Health | Whether the Cocos and WeChat builds succeed reliably. |
| Runtime Playability | Whether the game can be launched, played, restarted, and completed. |
| Gameplay Correctness | Whether the implementation matches the approved GDD. |
| Visual Usability | Whether the game is readable, responsive, and visually coherent. |
| Art Consistency | Whether produced assets match the Art Bible. |
| Intent Alignment | Whether the result matches the producer's idea and approved decisions. |
| WeChat Readiness | Whether package size, resource loading, and platform constraints are acceptable. |
| Performance | FPS, memory, loading time, package size, and runtime stability. |
| Security and Ops | Secrets handling, deployment logs, rollback plan, and production observability. |

Benchmark references tracked by the project:

- GameDevBench.
- GameCraft-Bench.
- OpenGame.
- PlayCoder.

## Security Model

Server access is collected at project start for end-to-end delivery, but raw credentials are not exposed to every agent.

Security rules:

- Store credentials in a secret vault.
- Agents request operations through controlled tools instead of reading raw secrets.
- DevOps and release tools receive only the minimum required permission.
- Logs must redact passwords, tokens, private keys, and server addresses when needed.
- Every secret write or deployment action must be audited.

## System Architecture

```mermaid
flowchart TB
    U["Producer"] --> CHAT["Studio Chat Rooms"]
    CHAT --> ROUTER["Role-Aware Agent Router"]
    ROUTER --> ORCH["Studio Orchestrator"]
    ORCH --> TASKS["Task Store / Mission Hub"]
    ORCH --> MEMORY["Production Memory System"]
    ORCH --> AUDIT["Append-Only Audit Log"]
    ORCH --> AGENTS["Specialized Game Agents"]
    AGENTS --> WORKSPACE["Role Workspaces"]
    AGENTS --> COCOS["Cocos Engine Bridge"]
    AGENTS --> QA["Game Evaluation Harness"]
    AGENTS --> RELEASE["WeChat / DevOps Release Tools"]
    COCOS --> BUILD["Playable Builds"]
    QA --> REPORTS["QA Reports"]
    RELEASE --> PROD["Production Environment"]
    PROD --> LIVEOPS["Analytics and LiveOps Backlog"]
    LIVEOPS --> MEMORY
    LIVEOPS --> CHAT
```

## Product Capability Modules

Game Pipeline Agents is implemented as a complete production system made of connected capability modules:

| Module | Responsibility |
| --- | --- |
| Studio Chat | Producer-facing rooms, role-aware routing, agent replies, structured message types, and cross-room handoff. |
| Agent Registry | Game-development roles, capabilities, permissions, routing rules, availability, and workspace ownership. |
| Workflow Orchestrator | Three-stage production state machine, phase gates, task creation, milestone transitions, and producer approval control. |
| Task and Mission Hub | Backlog, ownership, status, blockers, acceptance criteria, linked artifacts, and milestone visibility. |
| Production Memory System | Project truth, role progress, producer decisions, artifact history, QA history, release memory, and reusable knowledge. |
| Role Workspaces | Producer, design, art, engineering, Cocos automation, QA, and DevOps workspaces with visible deliverables. |
| Artifact Registry | GDD, Art Bible, assets, manifests, scene blueprints, code changes, builds, reports, and deployment records. |
| Cocos Engine Bridge | Cocos project validation, asset import, scene graph inspection, blueprint application, prefab updates, script generation, and builds. |
| Asset Pipeline | Art direction, asset production, cleanup, sprite sheets, animation strips, asset manifests, and runtime packaging. |
| QA and Evaluation Harness | Build verification, runtime playability, visual QA, playtest automation, bug reproduction, and release gate scoring. |
| WeChat Release Pipeline | WeChat mini-game packaging, preview, upload preparation, package-size checks, resource strategy, and platform readiness. |
| DevOps and LiveOps | Secret-controlled deployment, rollback, logs, analytics plans, iteration backlog, and production tuning. |
| Audit and Observability | Append-only events, tool-call traces, message records, artifact lineage, cost and runtime telemetry, and redacted operational logs. |

The architecture uses Clowder-style multi-agent rooms, agent registries, message routing, invocation queues, task stores, MCP callback tools, workspace explorers, production memory, and append-only audit logs as collaboration primitives. The game-specific layer adds production phases, game roles, Cocos automation, asset pipelines, playtest evaluation, and WeChat release gates.

## Current Status

This repository contains the product specification for Game Pipeline Agents. The implementation scope covers the complete product system described above: studio collaboration, agent execution, production memory, role workspaces, Cocos automation, QA evaluation, release operations, and continuous iteration.
