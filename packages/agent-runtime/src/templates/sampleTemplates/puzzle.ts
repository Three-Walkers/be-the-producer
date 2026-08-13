import type { IdeaClarificationTemplate } from "../types.js";

export const puzzleSampleTemplate: IdeaClarificationTemplate = {
  id: "sample-puzzle",
  category: "puzzle",
  priority: 60,
  matcher: {
    anyOf: ["解谜", "谜题", "拼图", "机关", "puzzle"]
  },
  designPrompts: [
    {
      id: "puzzle-state-language",
      text: "玩家需要观察和改变的谜题状态分别是什么，哪些状态必须始终可见？",
      priority: 20
    },
    {
      id: "puzzle-action-semantics",
      text: "一次输入只改变一个对象，还是会触发连锁规则？"
    },
    {
      id: "puzzle-recovery",
      text: "错误操作允许撤销、局部重置，还是只提供整关重来？"
    },
    {
      id: "shared-first-playable",
      text: "首个可玩版本最需要证明哪条玩法假设？"
    }
  ],
  artPrompts: [
    {
      id: "puzzle-state-readability",
      text: "可交互、已完成和不可用状态分别用哪些视觉线索区分？",
      priority: 15
    },
    {
      id: "puzzle-clue-hierarchy",
      text: "线索要融入场景让玩家发现，还是以明确的符号系统呈现？"
    },
    {
      id: "puzzle-feedback-density",
      text: "解题反馈要克制安静，还是用强动画和音效确认每一步？"
    }
  ]
};
