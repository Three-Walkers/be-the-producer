import type { AgentContract } from "@game-pipeline/shared-schemas";

export const defaultAgentContracts: AgentContract[] = [
  {
    agentId: "studio_orchestrator",
    displayName: "Studio Orchestrator",
    roleScope: "Maintains workflow state, routing, phase gates, task decomposition, and cross-agent coordination.",
    roomMemberships: ["studio-main", "design-room", "art-room", "engineering-room", "qa-room", "release-room"],
    stageLeads: [
      "concept_discussion",
      "concept_review",
      "production",
      "first_playable_review",
      "release_preparation",
      "release_gate",
      "production_deploy",
      "liveops"
    ],
    modelProfile: {
      capability: "reasoning",
      costTier: "standard",
      contextPolicy: "project_pack"
    },
    workspace: "shared/milestones/",
    memoryScopes: {
      read: ["project", "role", "decision", "artifact", "qa", "release", "producer_preference", "knowledge"],
      write: ["project", "role", "decision", "knowledge"]
    },
    tools: [
      "create_room",
      "route_message",
      "create_task",
      "update_task",
      "create_phase_gate",
      "write_audit_event",
      "build_task_board_snapshot"
    ],
    forbiddenActions: ["make_producer_decision", "read_secret_plaintext", "generate_final_game_content"],
    handoffTargets: [
      "producer",
      "game_designer",
      "art_director",
      "asset_production",
      "cocos_tech_lead",
      "gameplay_programmer",
      "cocos_automation",
      "qa_evaluator",
      "wechat_platform",
      "devops",
      "liveops_analytics"
    ],
    messageTypes: ["plan_submission", "progress_update", "decision_request", "blocker", "handoff"],
    progressKeywords: ["进度", "状态", "卡住", "阻塞", "阶段", "任务", "现在"]
  },
  {
    agentId: "producer",
    displayName: "Producer Agent",
    roleScope: "Controls scope, schedule, risks, milestone reviews, and producer decision records.",
    roomMemberships: ["studio-main", "design-room", "qa-room", "release-room"],
    stageLeads: ["concept_review", "first_playable_review", "release_gate", "liveops"],
    modelProfile: {
      capability: "reasoning",
      costTier: "standard",
      contextPolicy: "project_pack"
    },
    workspace: "agents/producer/",
    memoryScopes: {
      read: ["project", "role", "decision", "artifact", "qa", "release", "producer_preference"],
      write: ["role", "decision", "producer_preference"]
    },
    tools: ["create_decision_request", "record_decision", "create_task", "update_task", "write_artifact"],
    forbiddenActions: ["write_gameplay_code", "generate_final_assets", "deploy_release"],
    handoffTargets: ["studio_orchestrator", "game_designer", "art_director", "qa_evaluator", "devops"],
    messageTypes: ["decision_request", "decision_record", "progress_update", "change_request", "review"],
    progressKeywords: ["范围", "排期", "风险", "审批", "评审", "决策", "里程碑"]
  },
  {
    agentId: "game_designer",
    displayName: "Game Designer Agent",
    roleScope: "Designs core loop, mechanics, progression, levels, balance, and GDD artifacts.",
    roomMemberships: ["studio-main", "design-room", "qa-room"],
    stageLeads: ["concept_discussion"],
    modelProfile: {
      capability: "reasoning",
      costTier: "standard",
      contextPolicy: "project_pack"
    },
    workspace: "agents/design/",
    memoryScopes: {
      read: ["project", "decision", "producer_preference", "artifact", "qa"],
      write: ["role", "decision", "artifact", "knowledge"]
    },
    tools: ["read_artifact", "write_artifact", "create_decision_request", "create_task", "update_task"],
    forbiddenActions: ["write_gameplay_code", "make_final_art_direction", "deploy_release", "read_secret_plaintext"],
    handoffTargets: ["producer", "art_director", "cocos_tech_lead", "gameplay_programmer", "qa_evaluator"],
    messageTypes: ["plan_submission", "decision_request", "progress_update", "change_request", "handoff"],
    progressKeywords: ["玩法", "机制", "gdd", "数值", "关卡", "核心循环", "世界观"]
  },
  {
    agentId: "art_director",
    displayName: "Art Director Agent",
    roleScope: "Defines Art Bible, visual style, UI visual direction, asset specs, and visual review gates.",
    roomMemberships: ["studio-main", "art-room", "qa-room"],
    stageLeads: ["concept_discussion", "production"],
    modelProfile: {
      capability: "vision",
      costTier: "standard",
      contextPolicy: "project_pack"
    },
    workspace: "agents/art/",
    memoryScopes: {
      read: ["project", "decision", "producer_preference", "artifact", "qa"],
      write: ["role", "artifact", "decision", "knowledge"]
    },
    tools: ["read_artifact", "write_artifact", "create_asset_spec", "review_asset", "create_task"],
    forbiddenActions: ["write_gameplay_code", "edit_cocos_scene_directly", "deploy_release", "read_secret_plaintext"],
    handoffTargets: ["asset_production", "cocos_automation", "qa_evaluator", "producer"],
    messageTypes: ["plan_submission", "asset_review", "decision_request", "progress_update", "handoff"],
    progressKeywords: ["美术", "风格", "art bible", "资产", "色板", "ui", "视觉"]
  },
  {
    agentId: "asset_production",
    displayName: "Asset Production Agent",
    roleScope: "Generates, normalizes, packages, and versions runtime-ready art assets.",
    roomMemberships: ["art-room", "engineering-room", "qa-room"],
    stageLeads: ["production"],
    modelProfile: {
      capability: "image_generation",
      costTier: "standard",
      contextPolicy: "role_pack"
    },
    workspace: "agents/art/processed-assets/",
    memoryScopes: {
      read: ["project", "decision", "artifact", "producer_preference"],
      write: ["role", "artifact", "knowledge"]
    },
    tools: ["generate_image", "render_svg_to_png", "postprocess_asset", "write_asset_manifest", "create_task"],
    forbiddenActions: ["decide_art_direction", "write_gameplay_code", "read_provider_api_key", "deploy_release"],
    handoffTargets: ["art_director", "cocos_automation", "qa_evaluator"],
    messageTypes: ["deliverable", "asset_review", "progress_update", "blocker", "handoff"],
    progressKeywords: ["资产", "sprite", "图集", "manifest", "图片", "动画", "生成"]
  },
  {
    agentId: "cocos_tech_lead",
    displayName: "Cocos Architecture Agent",
    roleScope: "Owns Cocos project architecture, scene blueprint strategy, asset loading contracts, module boundaries, and performance budgets without writing gameplay code or operating editor builds directly.",
    roomMemberships: ["engineering-room", "studio-main", "qa-room"],
    stageLeads: ["production"],
    modelProfile: {
      capability: "coding",
      costTier: "standard",
      contextPolicy: "project_pack"
    },
    workspace: "agents/engineering/",
    memoryScopes: {
      read: ["project", "decision", "artifact", "qa", "knowledge"],
      write: ["role", "artifact", "knowledge"]
    },
    tools: ["write_artifact", "create_scene_blueprint", "create_task", "review_code"],
    forbiddenActions: ["approve_release_gate", "read_secret_plaintext", "make_producer_decision"],
    handoffTargets: ["gameplay_programmer", "cocos_automation", "qa_evaluator", "wechat_platform"],
    messageTypes: ["progress_update", "build_failure", "blocker", "handoff"],
    progressKeywords: ["cocos", "架构", "场景", "prefab", "性能", "资源加载", "构建"]
  },
  {
    agentId: "gameplay_programmer",
    displayName: "Gameplay Programmer Agent",
    roleScope: "Implements TypeScript gameplay systems, UI logic, state machines, and integration code.",
    roomMemberships: ["engineering-room", "qa-room"],
    stageLeads: ["production"],
    modelProfile: {
      capability: "coding",
      costTier: "standard",
      contextPolicy: "role_pack"
    },
    workspace: "assets/scripts/",
    memoryScopes: {
      read: ["project", "decision", "artifact", "qa", "knowledge"],
      write: ["role", "artifact", "knowledge"]
    },
    tools: ["write_code", "run_typecheck", "create_task", "update_task"],
    forbiddenActions: ["change_art_direction", "deploy_release", "read_secret_plaintext"],
    handoffTargets: ["cocos_automation", "qa_evaluator", "cocos_tech_lead"],
    messageTypes: ["deliverable", "progress_update", "build_failure", "blocker", "handoff"],
    progressKeywords: ["代码", "typescript", "玩法实现", "bug", "编译", "ui逻辑", "状态机"]
  },
  {
    agentId: "cocos_automation",
    displayName: "Cocos Automation Agent",
    roleScope: "Operates Cocos through the engine bridge for asset imports, scene blueprints, prefabs, and builds.",
    roomMemberships: ["engineering-room", "qa-room", "release-room"],
    stageLeads: ["production", "release_preparation"],
    modelProfile: {
      capability: "coding",
      costTier: "standard",
      contextPolicy: "role_pack"
    },
    workspace: "agents/cocos-automation/",
    memoryScopes: {
      read: ["project", "decision", "artifact", "qa", "knowledge"],
      write: ["role", "artifact", "knowledge"]
    },
    tools: ["cocos_validate_project", "cocos_import_assets", "cocos_apply_blueprint", "cocos_build"],
    forbiddenActions: ["edit_scene_serialization_uncontrolled", "read_secret_plaintext", "approve_release_gate"],
    handoffTargets: ["gameplay_programmer", "qa_evaluator", "wechat_platform"],
    messageTypes: ["deliverable", "progress_update", "build_failure", "blocker", "handoff"],
    progressKeywords: ["cocos", "导入", "场景", "构建", "blueprint", "prefab", "编辑器"]
  },
  {
    agentId: "qa_evaluator",
    displayName: "Game Evaluator / QA Agent",
    roleScope: "Evaluates the game product through playtests, screenshots, recordings, bugs, and release gates.",
    roomMemberships: ["studio-main", "qa-room", "engineering-room", "art-room", "release-room"],
    stageLeads: ["first_playable_review", "release_gate"],
    modelProfile: {
      capability: "evaluation",
      costTier: "standard",
      contextPolicy: "project_pack"
    },
    workspace: "agents/qa/",
    memoryScopes: {
      read: ["project", "decision", "artifact", "qa", "release", "producer_preference"],
      write: ["role", "qa", "artifact", "knowledge"]
    },
    tools: ["write_artifact", "run_playtest", "create_bug_report", "create_release_gate"],
    forbiddenActions: ["fix_code_directly", "approve_producer_decision", "read_secret_plaintext"],
    handoffTargets: ["gameplay_programmer", "art_director", "asset_production", "cocos_automation", "wechat_platform", "devops"],
    messageTypes: ["playtest_summary", "bug_report", "qa_failure", "release_gate", "progress_update", "blocker"],
    progressKeywords: ["qa", "测试", "试玩", "bug", "发布门禁", "截图", "录屏", "评估"]
  },
  {
    agentId: "wechat_platform",
    displayName: "WeChat Platform Agent",
    roleScope: "Handles WeChat mini-game packaging, preview readiness, upload preparation, package size, and platform checks.",
    roomMemberships: ["release-room", "engineering-room", "qa-room"],
    stageLeads: ["release_preparation"],
    modelProfile: {
      capability: "reasoning",
      costTier: "standard",
      contextPolicy: "role_pack"
    },
    workspace: "shared/build-artifacts/",
    memoryScopes: {
      read: ["project", "decision", "artifact", "qa", "release"],
      write: ["role", "release", "artifact", "knowledge"]
    },
    tools: ["check_wechat_package", "prepare_preview", "prepare_upload_report", "create_task"],
    forbiddenActions: ["deploy_server", "read_upload_secret_plaintext", "approve_release_gate"],
    handoffTargets: ["qa_evaluator", "devops", "liveops_analytics"],
    messageTypes: ["deliverable", "progress_update", "build_failure", "release_gate", "handoff"],
    progressKeywords: ["微信", "小游戏", "包体", "预览", "上传", "分包", "平台"]
  },
  {
    agentId: "devops",
    displayName: "DevOps Agent",
    roleScope: "Handles pre-release deployment planning, server deployment, redacted logs, rollback, health checks, and production readiness.",
    roomMemberships: ["release-room", "studio-main"],
    stageLeads: ["release_preparation", "production_deploy"],
    modelProfile: {
      capability: "reasoning",
      costTier: "standard",
      contextPolicy: "role_pack"
    },
    workspace: "agents/devops/",
    memoryScopes: {
      read: ["project", "decision", "artifact", "qa", "release"],
      write: ["role", "release", "knowledge"]
    },
    tools: ["create_deploy_plan", "run_deploy_tool", "write_redacted_log", "create_rollback_plan", "run_health_check"],
    forbiddenActions: ["show_secret_plaintext", "deploy_without_approval", "delete_audit_log"],
    handoffTargets: ["wechat_platform", "qa_evaluator", "liveops_analytics", "producer"],
    messageTypes: ["deployment_record", "progress_update", "blocker", "release_gate", "handoff"],
    progressKeywords: ["部署", "服务器", "回滚", "日志", "运维", "健康检查", "secret"]
  },
  {
    agentId: "liveops_analytics",
    displayName: "LiveOps / Analytics Agent",
    roleScope: "Tracks post-release data and turns feedback into iteration backlog and tuning plans.",
    roomMemberships: ["studio-main", "release-room", "design-room"],
    stageLeads: ["liveops"],
    modelProfile: {
      capability: "evaluation",
      costTier: "standard",
      contextPolicy: "project_pack"
    },
    workspace: "shared/release-notes/",
    memoryScopes: {
      read: ["project", "decision", "artifact", "qa", "release", "producer_preference", "knowledge"],
      write: ["role", "release", "knowledge", "decision"]
    },
    tools: ["define_analytics_events", "analyze_liveops_data", "create_iteration_backlog", "create_task"],
    forbiddenActions: ["collect_private_personal_data", "auto_deploy_tuning", "read_secret_plaintext"],
    handoffTargets: ["producer", "game_designer", "gameplay_programmer", "qa_evaluator"],
    messageTypes: ["progress_update", "change_request", "handoff"],
    progressKeywords: ["数据", "埋点", "迭代", "liveops", "调优", "留存", "反馈"]
  }
];
