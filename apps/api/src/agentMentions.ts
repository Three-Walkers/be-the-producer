import { defaultAgentContracts } from "@game-pipeline/agent-runtime";

const mentionAliases: Record<string, string[]> = {
  studio_orchestrator: ["studio_orchestrator", "studio orchestrator", "orchestrator", "总控", "调度", "主持人"],
  producer: ["producer", "producer agent", "制作人协调", "制作"],
  game_designer: ["game_designer", "game designer", "策划", "游戏策划"],
  design_quality_reviewer: ["design_quality_reviewer", "策划质量总监", "策划审查"],
  art_director: ["art_director", "art director", "美术", "美术导演"],
  asset_production: ["asset_production", "asset production", "资产", "资产生产"],
  visual_quality_reviewer: ["visual_quality_reviewer", "视觉质量总监", "视觉审查"],
  cocos_tech_lead: ["cocos_tech_lead", "cocos tech lead", "cocos", "技术负责人", "架构"],
  gameplay_programmer: ["gameplay_programmer", "gameplay programmer", "程序", "玩法程序", "开发"],
  cocos_automation: ["cocos_automation", "cocos automation", "自动化", "编辑器"],
  qa_evaluator: ["qa_evaluator", "game evaluator", "qa", "测试", "评估"],
  wechat_platform: ["wechat_platform", "wechat platform", "微信", "平台"],
  devops: ["devops", "运维", "部署"],
  liveops_analytics: ["liveops_analytics", "liveops", "analytics", "运营", "数据"]
};

/** Pure routing utility: importing it must not construct a live project store. */
export function extractMentionedAgents(content: string): string[] {
  const normalized = content.toLowerCase();
  const aliases = defaultAgentContracts.flatMap((agent) =>
    [agent.agentId, agent.displayName, ...(mentionAliases[agent.agentId] ?? [])]
      .map((alias) => ({ alias: alias.toLowerCase(), agentId: agent.agentId }))
  ).sort((left, right) => right.alias.length - left.alias.length);
  const mentioned: string[] = [];
  for (const match of normalized.matchAll(/@/g)) {
    const tail = normalized.slice(match.index! + 1);
    const selected = aliases.find(({ alias }) => tail.startsWith(alias) &&
      (!tail[alias.length] || /[\s,，、:：;；!?！？。@]/u.test(tail[alias.length]!)));
    if (selected) mentioned.push(selected.agentId);
  }
  return [...new Set(mentioned)];
}
