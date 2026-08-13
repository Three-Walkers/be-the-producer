import type { IdeaClarificationTemplate } from "../types.js";

/**
 * The original repository demo is kept as an explicit sample, not as product
 * policy. Removing this registration removes all yarn/basket/cute knowledge.
 */
export const yarnDefenseSampleTemplate: IdeaClarificationTemplate = {
  id: "sample-yarn-defense",
  category: "tap-defense",
  priority: 100,
  matcher: {
    anyOf: ["毛线", "线团", "yarn", "防守", "篮子", "篮筐"]
  },
  designPrompts: [
    {
      id: "yarn-physics",
      text: "毛线球的核心物理行为是什么：弹开、滚动、缠住、还是被点击后短暂停滞？",
      matcher: { anyOf: ["毛线", "线团", "球", "yarn"] },
      priority: 20
    },
    {
      id: "basket-failure-boundary",
      text: "防守失败的判定要精确到什么程度：碰到篮筐边缘、越过某条线，还是落入篮内才失败？",
      matcher: { anyOf: ["防守", "守", "篮", "basket"] },
      priority: 15
    },
    {
      id: "wechat-first-playable",
      text: "微信小游戏首个可玩要优先验证哪件事：上手速度、单局留存、分享复玩，还是手感反馈？",
      matcher: { anyOf: ["微信", "小游戏", "wechat"] },
      priority: 10
    },
    {
      id: "cozy-emotion",
      text: "你希望玩家的主要情绪更偏轻松治愈、手忙脚乱的快乐，还是紧张但不挫败？",
      matcher: { anyOf: ["可爱", "轻松", "治愈", "cute", "cozy"] }
    }
  ],
  artPrompts: [
    {
      id: "yarn-material-style",
      text: "毛线球和场景要偏手作毛绒、扁平贴纸，还是更像柔软 3D 玩具？",
      matcher: { anyOf: ["毛线", "线团", "猫", "可爱", "yarn", "cute"] },
      priority: 20
    },
    {
      id: "cozy-palette",
      text: "整体色彩要偏奶油暖色、清爽浅色，还是高对比的街机糖果色？",
      matcher: { anyOf: ["轻松", "治愈", "可爱", "cute", "cozy"] },
      priority: 10
    },
    {
      id: "basket-language",
      text: "篮子/边界要明显游戏化，还是融入生活化场景让防守目标更自然？",
      matcher: { anyOf: ["篮球", "篮", "basket"] }
    }
  ]
};
