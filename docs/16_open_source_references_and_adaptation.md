# 16. 开源参考与适配策略

## 1. 采用原则

开源项目作为角色定义、协作结构、技能流程和工具实现参考，不直接照搬产品语义。Game Pipeline Agents 的核心语义是“制作人参与的微信小游戏生产工作室”，所有外部项目必须适配到 Cocos、微信小游戏、Production Memory、Model Gateway 和白盒审计体系。

## 2. Clowder AI

用途：

- 多 Agent 群聊底座。
- Thread/Room。
- Agent Registry。
- @mention 路由。
- Invocation Queue。
- Task Store。
- Workspace Explorer。
- MCP callback。
- Append-only audit log。

适配方式：

- Cat/Agent 概念替换为游戏工作室角色。
- Thread 映射为房间。
- Mission Hub 映射为 Task and Mission Hub。
- Audit Log 扩展为生产审计。
- Workspace Explorer 扩展为角色工作空间。

不直接复用：

- 猫设和通用社交语义。
- 非游戏生产的默认任务分类。

## 3. Claude-Code-Game-Studios

用途：

- 策划 Agent 基础：`game-designer`。
- 美术 Agent 基础：`art-director`。
- 角色协作原则。
- Art Bible、Asset Spec、Gate、QA、Release 等 workflow 思路。

适配方式：

- 移除 Claude Code 绑定。
- 改为服务端 Agent runtime。
- 改为 Cocos / 微信小游戏语义。
- 写入我们的 Agent Registry。
- 使用 Model Gateway 调用模型。

## 4. OpenAgenticGame-Studios

用途：

- 大规模游戏工作室角色库。
- Design Team、Art Team、Programming、QA、Production、Publish 角色划分。
- Cocos Creator specialist 参考。

适配方式：

- 作为角色全集参考。
- 不一次性启用 85 个 Agent。
- 抽取适合微信小游戏的角色。
- 将大型游戏层级压缩为轻量工作室结构。

## 5. gamestudio-subagents

用途：

- 精简角色划分参考。
- Sr Game Designer、Sr Game Artist、Technical Artist、UI/UX、QA 等基础描述。

适配方式：

- 作为第一批角色职责对照。
- 将 Godot 语义替换为 Cocos。
- 将 terminal 协作改为群聊和任务系统。

## 6. openagenticgame-gdd

用途：

- GDD 模板。
- 玩法、机制、世界观、技术、美术、管理章节结构。
- 面向 AI Agent 的 Markdown 文档体系。

适配方式：

- 作为 Game Designer Agent 的模板库。
- 只启用微信小游戏所需章节。
- 将大型设计文档压缩为 baseline GDD。
- 将资产和技术章节连接到 Art Bible、SceneBlueprint 和 Task Store。

## 7. OpenGame

用途：

- Game Skill。
- Template Skill。
- Debug Skill。
- 动态运行和可玩性验证。
- OpenGame-Bench 思路。

适配方式：

- 将 Web game 模板思想迁移到 Cocos 模板。
- 将 Debug Skill 思路用于 Cocos 构建和运行修复。
- 将可玩性验证纳入 Cocos MiniGame Bench。

## 8. ai-game-art-pipeline-skill

用途：

- 将 AI 图像和视频变成 runtime-ready 资产。
- sprite、icon、background、video-to-frames。
- runtime 风险审计。
- provider-neutral 接入。

适配方式：

- 接入 Asset Production Agent。
- Provider 由 Model Gateway 管理。
- 输出进入 art workspace 和 asset manifest。
- 移动端风险检查纳入美术 QA。

## 9. agent-sprite-forge

用途：

- 2D sprite。
- sprite sheet。
- 地图素材。
- 透明帧。
- GIF 预览。
- deterministic post-processing。

适配方式：

- 作为 Asset Production Agent 的工具链。
- 输出角色、怪物、VFX、地图素材。
- 与 Cocos 导入格式对齐。
- 输出 metadata 写入 asset manifest。

## 10. Funplay Cocos MCP / cocos-code-mode

用途：

- Cocos Editor 自动化。
- AI 到 Cocos 的工具桥。
- 项目、资源、场景、构建操作参考。

适配方式：

- 作为 Cocos Bridge 的实现参考。
- 使用 SceneBlueprint 避免 LLM 直接改 `.scene`。
- 工具调用进入审计日志。
- 构建结果进入 QA 和微信发布流水线。

## 11. License 和 Attribution

使用外部项目时：

- 保留原 license。
- 在 docs 和 NOTICE 中记录来源。
- 复制代码前检查 license。
- Prompt 或 Agent 定义改写时保留 attribution。
- 不复制含未知授权的素材。

## 12. 适配优先级

| 优先级 | 项目 | 理由 |
| --- | --- | --- |
| 高 | Clowder AI | 产品协作底座最接近。 |
| 高 | Claude-Code-Game-Studios | 策划和美术 Agent 基础最合适。 |
| 高 | ai-game-art-pipeline-skill | 美术资产生产流程关键。 |
| 高 | agent-sprite-forge | 微信小游戏 2D 资产适配度高。 |
| 中 | openagenticgame-gdd | GDD 模板有价值，但需要裁剪。 |
| 中 | OpenGame | 可玩验证和 Debug Skill 值得吸收。 |
| 中 | OpenAgenticGame-Studios | 角色库丰富，但体量过大。 |
| 中 | gamestudio-subagents | 精简参考，有用但定义较薄。 |

## 13. 不直接照搬的内容

- 绑定某个 CLI 的运行方式。
- 大型 AAA 角色层级。
- 与微信小游戏无关的平台门禁。
- 没有制作人审批的自动自治流程。
- 将 API key 分散到 Agent 的做法。
- 直接让模型修改引擎序列化文件。
