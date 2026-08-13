import type { IdeaClarificationTemplate } from "../types.js";

export const runnerSampleTemplate: IdeaClarificationTemplate = {
  id: "sample-runner",
  category: "runner",
  priority: 50,
  matcher: {
    anyOf: ["跑酷", "奔跑", "无尽跑", "runner", "endless run"]
  },
  designPrompts: [
    {
      id: "runner-input-model",
      text: "玩家控制的是跳跃、换道、冲刺，还是这些动作的组合？",
      priority: 20
    },
    {
      id: "runner-obstacle-contract",
      text: "障碍物如何提前给出可读预警，碰撞后的惩罚是什么？"
    },
    {
      id: "runner-session-shape",
      text: "关卡有明确终点，还是速度和难度持续增长的无尽模式？"
    },
    {
      id: "shared-first-playable",
      text: "首个可玩版本最需要证明哪条玩法假设？"
    }
  ],
  artPrompts: [
    {
      id: "runner-lane-readability",
      text: "高速移动时，安全路径和危险物应靠轮廓、色彩还是运动节奏区分？",
      priority: 15
    },
    {
      id: "runner-speed-language",
      text: "速度感主要来自镜头、环境视差、拖尾，还是角色动画？"
    },
    {
      id: "runner-world-variation",
      text: "场景变化是纯装饰分段，还是必须同步表达难度升级？"
    }
  ]
};
