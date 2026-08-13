import type { IdeaClarificationFallback } from "../types.js";

export const genericIdeaFallback: IdeaClarificationFallback = {
  id: "generic-idea-fallback",
  designPrompts: [
    {
      id: "core-player-goal",
      text: "玩家每局最核心的一句话目标是什么？"
    },
    {
      id: "failure-recovery",
      text: "玩家失败后应该立刻想再来一局，还是先看到成长/奖励反馈？"
    },
    {
      id: "first-playable-proof",
      text: "首个可玩版本最需要证明哪条玩法假设？"
    }
  ],
  artPrompts: [
    {
      id: "visual-references",
      text: "有没有明确参考图、参考游戏或不想出现的视觉风格？"
    },
    {
      id: "visual-priority",
      text: "首个可玩阶段优先保证角色识别、操作反馈，还是场景氛围？"
    },
    {
      id: "platform-readability",
      text: "目标设备和游玩距离对字号、色彩与轮廓辨识有什么要求？"
    }
  ]
};
