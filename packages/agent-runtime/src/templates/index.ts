export * from "./types.js";
export * from "./templateRegistry.js";
export * from "./sampleTemplates/index.js";

import { IdeaTemplateRegistry } from "./templateRegistry.js";
import { sampleIdeaFallback, sampleIdeaTemplates } from "./sampleTemplates/index.js";

export function createSampleIdeaTemplateRegistry(): IdeaTemplateRegistry {
  return new IdeaTemplateRegistry(sampleIdeaTemplates, sampleIdeaFallback);
}
