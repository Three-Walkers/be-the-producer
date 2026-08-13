export type ClarificationChannel = "design" | "art";

/**
 * Declarative matching keeps the selector independent from game genres and
 * makes templates safe to register without executing template-owned code.
 */
export interface IdeaTemplateMatcher {
  anyOf?: readonly string[];
  allOf?: readonly string[];
  noneOf?: readonly string[];
}

export interface IdeaClarificationPrompt {
  id: string;
  text: string;
  matcher?: IdeaTemplateMatcher;
  priority?: number;
}

export interface IdeaClarificationTemplate {
  id: string;
  category: string;
  priority: number;
  matcher: IdeaTemplateMatcher;
  designPrompts: readonly IdeaClarificationPrompt[];
  artPrompts: readonly IdeaClarificationPrompt[];
}

export interface IdeaClarificationFallback {
  id: string;
  designPrompts: readonly IdeaClarificationPrompt[];
  artPrompts: readonly IdeaClarificationPrompt[];
}

export interface ResolvedIdeaPrompt {
  channel: ClarificationChannel;
  promptId: string;
  templateId: string;
  text: string;
  effectivePriority: number;
}

export interface IdeaTemplateSelection {
  idea: string;
  matchedTemplateIds: readonly string[];
  usedFallback: boolean;
  designPrompts: readonly string[];
  artPrompts: readonly string[];
  resolvedPrompts: readonly ResolvedIdeaPrompt[];
}

export interface IdeaTemplateSelectionOptions {
  maxPromptsPerChannel?: number;
  minimumPromptsPerChannel?: number;
}
