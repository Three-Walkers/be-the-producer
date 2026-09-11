import assert from "node:assert/strict";
import { ContractValidationError, QualityReviewValidationError } from "@game-pipeline/shared-schemas";
import { extractMentionedAgents } from "../apps/api/dist/agentMentions.js";

for (const error of [
  new QualityReviewValidationError([{ path: "$.risks[0].riskId", code: "missing_property", message: "Required riskId is missing." }]),
  new ContractValidationError("GameContract", [{ path: "$.stateModel.states", code: "missing_property", message: "Required states is missing." }])
]) {
  assert.match(error.message, /\$\./);
  assert.match(error.message, /\[missing_property\]/);
  assert.match(error.message, /Required/);
  assert.equal(error.issues.length, 1);
}
assert.deepEqual(extractMentionedAgents("@策划质量总监 @视觉质量总监 审查"), ["design_quality_reviewer", "visual_quality_reviewer"]);
assert.deepEqual(extractMentionedAgents("@策划 @美术 @策划"), ["game_designer", "art_director"]);
assert.deepEqual(extractMentionedAgents("@game_designer，修改 @cocos automation: 构建"), ["game_designer", "cocos_automation"]);
assert.deepEqual(extractMentionedAgents("@策划未注册角色 @qa_evaluator_unknown"), []);
assert.deepEqual(extractMentionedAgents("@制作人协调 @producer"), ["producer"]);
console.log("Actionable validation and exact role mention regressions passed.");
