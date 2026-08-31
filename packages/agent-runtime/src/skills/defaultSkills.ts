import type { AgentSkillDefinition } from "./skillRegistry.js";
import { AgentSkillRegistry } from "./skillRegistry.js";
import { defaultAgentContracts } from "../agents/defaultAgents.js";

export const defaultAgentSkillDefinitions: AgentSkillDefinition[] = [
  {
    skillId: "game-generation-router",
    name: "游戏生成任务路由",
    version: "1.0.0",
    description: "把自然语言游戏想法拆成契约、资产、实现、试玩和发布工作流。",
    riskLevel: "standard",
    origin: "internal_clean_room",
    requiredTools: ["create_task"],
    instructions: [
      "先锁定玩家幻想、核心动词、单局长度、失败与重开，再拆分专业任务。",
      "生成必须经过 GameContract、SceneBlueprint、PlaytestContract 与独立质量审查，禁止一步跳到成品声明。",
      "只路由和拆解，不替专业角色创作最终策划、美术、代码或发布产物。"
    ]
  },
  {
    skillId: "level-design",
    name: "关卡与节奏设计",
    version: "1.0.0",
    description: "把玩法动词转成可测试的关卡、波次、路线与难度节奏。",
    riskLevel: "standard",
    origin: "internal_clean_room",
    requiredTools: ["write_artifact"],
    instructions: [
      "每个机制按安全教学、带代价测试、与既有机制组合三个节拍展开。",
      "关卡内容必须数据化并使用稳定 ID，明确入口、出口、胜负、重开、预算和可达性约束。",
      "强度应波动上升并保留恢复段；程序生成必须有可完成性、出生点和必需目标验证。"
    ]
  },
  {
    skillId: "balance-analysis",
    name: "数值与平衡分析",
    version: "1.0.0",
    description: "以假设、模拟和试玩证据设计难度、奖励、经济与随机性。",
    riskLevel: "standard",
    origin: "internal_clean_room",
    requiredTools: ["write_artifact"],
    instructions: [
      "把目标体验翻译成可观测指标、参数范围、基线、上限与失败阈值。",
      "优先增加行为和敌人变化，再增加纯数值倍率；所有增长曲线必须有上限。",
      "给出模拟或试玩验证计划，不得仅凭主观判断自动修改正式数值。"
    ]
  },
  {
    skillId: "cocos-architecture",
    name: "Cocos 架构设计",
    version: "1.0.0",
    description: "约束 Cocos Creator 场景、组件、资源、输入和性能边界。",
    riskLevel: "standard",
    origin: "internal_clean_room",
    requiredTools: ["create_scene_blueprint"],
    instructions: [
      "模拟状态归 gameplay/domain 所有，渲染与节点只消费状态，不把 Scene 当玩法事实源。",
      "SceneBlueprint 显式声明节点、组件、属性、引用和稳定 testId，禁止按显示名推断业务。",
      "提前锁定资源键、Prefab/场景边界、输入动作映射、保存格式、调试开关和移动端性能预算。"
    ]
  },
  {
    skillId: "gameplay-logic",
    name: "玩法逻辑实现",
    version: "1.0.0",
    description: "把 GameContract 实现为可测试的 TypeScript 状态机和组件。",
    riskLevel: "standard",
    origin: "internal_clean_room",
    requiredTools: ["write_code"],
    instructions: [
      "状态、动作、胜负和 runtime signal 必须逐项映射 GameContract，新增语义先变更契约。",
      "固定更新顺序并使用 dt/固定时间步；随机玩法使用可记录 seed，禁止用帧数或 setTimeout 驱动核心规则。",
      "配置与内容数据独立于逻辑，关键边界提供确定性测试和可观测信号。"
    ]
  },
  {
    skillId: "asset-production",
    name: "运行资产生产",
    version: "1.0.0",
    description: "从 Art Bible 生成、归一化、登记并验证 Cocos 运行资产。",
    riskLevel: "standard",
    origin: "internal_clean_room",
    requiredTools: ["generate_raster_asset", "write_asset_manifest"],
    instructions: [
      "先锁定 Art Bible 的形状、轮廓、色板、材质、尺度和禁止项，再生成实际运行 PNG。",
      "保持锚点、朝向、画布、帧尺寸和命名稳定；联系表只能用于审查，不能替代运行资产。",
      "Manifest v2 必须声明 alphaPolicy，并在视觉审查和 Cocos import receipt 通过前保持待审。"
    ]
  },
  {
    skillId: "cocos-mobile-ui",
    name: "Cocos 移动游戏 UI",
    version: "1.0.0",
    description: "设计并实现适合微信小游戏与移动小屏的 HUD、菜单和触控界面。",
    riskLevel: "standard",
    origin: "internal_clean_room",
    requiredTools: [],
    instructions: [
      "中心区域优先保留给玩法；HUD 使用稳定边角层级、安全区和清晰数字排版。",
      "核心触控目标至少 44 CSS 像素等效尺寸，不依赖 hover，并覆盖刘海、长屏和横竖屏策略。",
      "意义不能只靠颜色表达；支持暂停、静音、减少动态效果和小屏对比度审查。"
    ]
  },
  {
    skillId: "game-playtest",
    name: "游戏试玩与前端 QA",
    version: "1.0.0",
    description: "依据 PlaytestContract 执行可复现试玩、截图取证和缺陷分级。",
    riskLevel: "standard",
    origin: "internal_clean_room",
    requiredTools: ["run_playtest"],
    instructions: [
      "只执行当前 PlaytestContract 的 required 场景、步骤、超时和质量门禁。",
      "每个结论绑定运行时握手、截图/事件/状态证据；不能用读代码代替试玩。",
      "失败与阻塞是有效结果，形成可复验缺陷并交回责任角色，不直接修代码或资产。"
    ]
  },
  {
    skillId: "deploy-game",
    name: "受控游戏部署",
    version: "1.0.0",
    description: "在发布批准后执行部署、健康检查、审计和回滚。",
    riskLevel: "high",
    origin: "internal_clean_room",
    requiredTools: ["run_deploy_tool"],
    instructions: [
      "部署前核对批准的 build、deployment plan、rollback plan、目标环境和密钥引用。",
      "先执行最小发布与健康检查，失败立即停止并保留脱敏日志，禁止连续盲目重试。",
      "只有真实部署报告和健康检查通过后才能交接 LiveOps；Skill 不授予发布审批权。"
    ]
  },
  {
    skillId: "game-analytics",
    name: "游戏 LiveOps 分析",
    version: "1.0.0",
    description: "从版本化埋点和发布数据构建可解释的指标、诊断与迭代建议。",
    riskLevel: "standard",
    origin: "internal_clean_room",
    requiredTools: ["analyze_liveops_data"],
    instructions: [
      "先固定事件 schema、指标口径、版本、时间窗、样本量和数据新鲜度，再计算结论。",
      "优先分析教程完成、失败点、局长、留存、转化和版本差异，并展示分母与不确定性。",
      "仪表盘是观测面而非事实生成器；调优建议必须形成待审批 backlog，不能自动部署。"
    ]
  },
  {
    skillId: "multiplayer-setup",
    name: "多人联机架构预研",
    version: "1.0.0",
    description: "在明确产品需求后评估权威服务器、同步、匹配、安全和成本。",
    riskLevel: "high",
    origin: "internal_clean_room",
    requiredTools: [],
    instructions: [
      "先确认联机是否为产品需求，再选择权威服务器、帧同步或状态同步，不把单机代码直接联网。",
      "必须覆盖身份、匹配、重连、延迟补偿、作弊面、区域部署、成本和数据合规。",
      "没有 Network Architect 与 Backend Engineer 角色时只允许预研，不进入实现或部署。"
    ]
  }
];

export const defaultAgentSkillRegistry = new AgentSkillRegistry(defaultAgentSkillDefinitions);
defaultAgentSkillRegistry.assertAgentBindings(defaultAgentContracts);
