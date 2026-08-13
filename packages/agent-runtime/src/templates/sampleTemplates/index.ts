export { genericIdeaFallback } from "./fallback.js";
export { puzzleSampleTemplate } from "./puzzle.js";
export { runnerSampleTemplate } from "./runner.js";
export { yarnDefenseSampleTemplate } from "./yarnDefense.js";

import { genericIdeaFallback } from "./fallback.js";
import { puzzleSampleTemplate } from "./puzzle.js";
import { runnerSampleTemplate } from "./runner.js";
import { yarnDefenseSampleTemplate } from "./yarnDefense.js";

export const sampleIdeaTemplates = Object.freeze([
  yarnDefenseSampleTemplate,
  puzzleSampleTemplate,
  runnerSampleTemplate
]);

export { genericIdeaFallback as sampleIdeaFallback };
