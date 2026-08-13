import assert from "node:assert/strict";
import {
  IdeaTemplateRegistry,
  createSampleIdeaTemplateRegistry,
  genericIdeaFallback
} from "../packages/agent-runtime/dist/templates/index.js";

const registry = createSampleIdeaTemplateRegistry();

const yarn = registry.select("做一个轻松可爱的微信毛线球防守篮子小游戏");
assert.deepEqual(yarn.matchedTemplateIds, ["sample-yarn-defense"]);
assert.equal(yarn.usedFallback, false);
assert.equal(yarn.designPrompts.length, 4);
assert.match(yarn.designPrompts[0], /毛线球的核心物理行为/);
assert.ok(yarn.designPrompts.some((prompt) => prompt.includes("篮筐边缘")));
assert.ok(yarn.designPrompts.some((prompt) => prompt.includes("微信小游戏")));
assert.ok(yarn.designPrompts.some((prompt) => prompt.includes("轻松治愈")));
assert.ok(yarn.artPrompts.some((prompt) => prompt.includes("手作毛绒")));
assert.ok(yarn.artPrompts.some((prompt) => prompt.includes("奶油暖色")));
assert.ok(yarn.artPrompts.some((prompt) => prompt.includes("篮子/边界")));

const puzzle = registry.select("做一个机关和符号驱动的解谜游戏");
assert.deepEqual(puzzle.matchedTemplateIds, ["sample-puzzle"]);
assert.equal(puzzle.usedFallback, false);
assert.ok(puzzle.designPrompts.some((prompt) => prompt.includes("谜题状态")));
assert.ok(puzzle.artPrompts.some((prompt) => prompt.includes("可交互、已完成和不可用")));

const runner = registry.select("做一个有换道和障碍物的无尽跑酷 runner");
assert.deepEqual(runner.matchedTemplateIds, ["sample-runner"]);
assert.equal(runner.usedFallback, false);
assert.ok(runner.designPrompts.some((prompt) => prompt.includes("跳跃、换道、冲刺")));
assert.ok(runner.artPrompts.some((prompt) => prompt.includes("高速移动")));

const combined = registry.select("可爱的毛线防守解谜跑酷小游戏", {
  maxPromptsPerChannel: 12,
  minimumPromptsPerChannel: 1
});
assert.deepEqual(combined.matchedTemplateIds, [
  "sample-yarn-defense",
  "sample-puzzle",
  "sample-runner"
]);
assert.equal(combined.resolvedPrompts[0]?.templateId, "sample-yarn-defense");
assert.ok(combined.designPrompts.some((prompt) => prompt.includes("谜题状态")));
assert.ok(combined.designPrompts.some((prompt) => prompt.includes("跳跃、换道、冲刺")));
assert.equal(
  combined.designPrompts.filter((prompt) => prompt === "首个可玩版本最需要证明哪条玩法假设？").length,
  1,
  "identical prompts from multiple categories must be de-duplicated"
);

const unknown = registry.select("做一个从未定义过的抽象实验作品");
assert.deepEqual(unknown.matchedTemplateIds, []);
assert.equal(unknown.usedFallback, true);
assert.deepEqual(unknown.designPrompts, genericIdeaFallback.designPrompts.map(({ text }) => text));
assert.deepEqual(unknown.artPrompts, genericIdeaFallback.artPrompts.map(({ text }) => text));
assert.ok(unknown.resolvedPrompts.every((prompt) => prompt.templateId === genericIdeaFallback.id));

// A new category is data supplied to the same registry; no selector branch is
// added or modified for this fixture.
const rhythmTemplate = {
  id: "fixture-rhythm",
  category: "rhythm",
  priority: 80,
  matcher: { anyOf: ["节奏", "rhythm"] },
  designPrompts: [
    { id: "rhythm-input", text: "拍点输入的判定窗口是多少？" },
    { id: "rhythm-failure", text: "连续失误如何影响本局状态？" },
    { id: "rhythm-song-shape", text: "一局对应完整曲目还是循环段落？" }
  ],
  artPrompts: [
    { id: "rhythm-beat-signal", text: "节拍用哪些视觉信号提前表达？" },
    { id: "rhythm-feedback", text: "准确与失误反馈如何区分？" },
    { id: "rhythm-stage", text: "舞台变化如何跟随音乐结构？" }
  ]
};
const extensibleRegistry = new IdeaTemplateRegistry([rhythmTemplate], genericIdeaFallback);
const rhythm = extensibleRegistry.select("一个双键节奏 rhythm 游戏");
assert.deepEqual(rhythm.matchedTemplateIds, ["fixture-rhythm"]);
assert.equal(rhythm.usedFallback, false);
assert.match(rhythm.designPrompts[0], /判定窗口/);

assert.throws(
  () => new IdeaTemplateRegistry([rhythmTemplate, rhythmTemplate], genericIdeaFallback),
  /Duplicate idea template id/
);

console.log("Idea template registry passed: yarn-defense, puzzle, runner, composition, fallback, extension");
