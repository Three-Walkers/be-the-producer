import type {
  ClarificationChannel,
  IdeaClarificationFallback,
  IdeaClarificationPrompt,
  IdeaClarificationTemplate,
  IdeaTemplateMatcher,
  IdeaTemplateSelection,
  IdeaTemplateSelectionOptions,
  ResolvedIdeaPrompt
} from "./types.js";

const DEFAULT_MAX_PROMPTS = 4;
const DEFAULT_MINIMUM_PROMPTS = 3;

interface PromptCandidate extends ResolvedIdeaPrompt {
  templateOrder: number;
  promptOrder: number;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function normalizedTerms(terms: readonly string[] | undefined): string[] {
  return (terms ?? []).map(normalizeSearchText).filter((term) => term.length > 0);
}

function matcherMatches(normalizedIdea: string, matcher: IdeaTemplateMatcher): boolean {
  const anyOf = normalizedTerms(matcher.anyOf);
  const allOf = normalizedTerms(matcher.allOf);
  const noneOf = normalizedTerms(matcher.noneOf);

  if (noneOf.some((term) => normalizedIdea.includes(term))) {
    return false;
  }
  if (allOf.some((term) => !normalizedIdea.includes(term))) {
    return false;
  }
  if (anyOf.length > 0 && !anyOf.some((term) => normalizedIdea.includes(term))) {
    return false;
  }
  return anyOf.length > 0 || allOf.length > 0;
}

function promptMatches(normalizedIdea: string, prompt: IdeaClarificationPrompt): boolean {
  return prompt.matcher === undefined || matcherMatches(normalizedIdea, prompt.matcher);
}

function promptDeduplicationKey(text: string): string {
  return normalizeSearchText(text).replaceAll(/\s+/gu, " ");
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertPrompt(prompt: IdeaClarificationPrompt, ownerId: string): void {
  if (prompt.id.trim().length === 0) {
    throw new Error(`Template ${ownerId} contains an empty prompt id`);
  }
  if (prompt.text.trim().length === 0) {
    throw new Error(`Template ${ownerId} contains an empty prompt: ${prompt.id}`);
  }
}

function assertTemplate(template: IdeaClarificationTemplate): void {
  if (template.id.trim().length === 0 || template.category.trim().length === 0) {
    throw new Error("Template id and category must be non-empty");
  }
  if (!Number.isFinite(template.priority)) {
    throw new Error(`Template ${template.id} priority must be finite`);
  }
  for (const prompt of [...template.designPrompts, ...template.artPrompts]) {
    assertPrompt(prompt, template.id);
  }
}

function toCandidates(
  normalizedIdea: string,
  template: IdeaClarificationTemplate,
  templateOrder: number,
  channel: ClarificationChannel
): PromptCandidate[] {
  const prompts = channel === "design" ? template.designPrompts : template.artPrompts;
  return prompts.flatMap((prompt, promptOrder) => {
    if (!promptMatches(normalizedIdea, prompt)) {
      return [];
    }
    return [{
      channel,
      promptId: prompt.id,
      templateId: template.id,
      text: prompt.text.trim(),
      effectivePriority: template.priority + (prompt.priority ?? 0),
      templateOrder,
      promptOrder
    }];
  });
}

function fallbackCandidates(
  fallback: IdeaClarificationFallback,
  channel: ClarificationChannel
): PromptCandidate[] {
  const prompts = channel === "design" ? fallback.designPrompts : fallback.artPrompts;
  return prompts.map((prompt, promptOrder) => ({
    channel,
    promptId: prompt.id,
    templateId: fallback.id,
    text: prompt.text.trim(),
    effectivePriority: Number.NEGATIVE_INFINITY,
    templateOrder: Number.MAX_SAFE_INTEGER,
    promptOrder
  }));
}

function orderCandidates(left: PromptCandidate, right: PromptCandidate): number {
  return right.effectivePriority - left.effectivePriority
    || left.templateOrder - right.templateOrder
    || left.promptOrder - right.promptOrder
    || left.promptId.localeCompare(right.promptId);
}

function deduplicateAndLimit(candidates: readonly PromptCandidate[], limit: number): PromptCandidate[] {
  const seen = new Set<string>();
  const result: PromptCandidate[] = [];
  for (const candidate of candidates) {
    const key = promptDeduplicationKey(candidate.text);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
    if (result.length === limit) {
      break;
    }
  }
  return result;
}

function publicPrompt(candidate: PromptCandidate): ResolvedIdeaPrompt {
  return {
    channel: candidate.channel,
    promptId: candidate.promptId,
    templateId: candidate.templateId,
    text: candidate.text,
    effectivePriority: candidate.effectivePriority
  };
}

/**
 * A pure, immutable registry. Category knowledge lives entirely in registered
 * templates; adding a genre never requires a selector branch.
 */
export class IdeaTemplateRegistry {
  readonly #templates: readonly IdeaClarificationTemplate[];
  readonly #fallback: IdeaClarificationFallback;

  constructor(templates: readonly IdeaClarificationTemplate[], fallback: IdeaClarificationFallback) {
    const ids = new Set<string>();
    for (const template of templates) {
      assertTemplate(template);
      if (ids.has(template.id)) {
        throw new Error(`Duplicate idea template id: ${template.id}`);
      }
      ids.add(template.id);
    }
    if (ids.has(fallback.id)) {
      throw new Error(`Fallback id conflicts with a template id: ${fallback.id}`);
    }
    for (const prompt of [...fallback.designPrompts, ...fallback.artPrompts]) {
      assertPrompt(prompt, fallback.id);
    }

    this.#templates = Object.freeze([...templates]);
    this.#fallback = fallback;
  }

  select(idea: string, options: IdeaTemplateSelectionOptions = {}): IdeaTemplateSelection {
    const maxPrompts = options.maxPromptsPerChannel ?? DEFAULT_MAX_PROMPTS;
    const minimumPrompts = options.minimumPromptsPerChannel ?? DEFAULT_MINIMUM_PROMPTS;
    assertPositiveInteger(maxPrompts, "maxPromptsPerChannel");
    assertPositiveInteger(minimumPrompts, "minimumPromptsPerChannel");
    if (minimumPrompts > maxPrompts) {
      throw new Error("minimumPromptsPerChannel cannot exceed maxPromptsPerChannel");
    }

    const normalizedIdea = normalizeSearchText(idea);
    const matchingTemplates = this.#templates
      .filter((template) => matcherMatches(normalizedIdea, template.matcher))
      .map((template, registrationOrder) => ({ template, registrationOrder }))
      .sort((left, right) => right.template.priority - left.template.priority
        || left.registrationOrder - right.registrationOrder
        || left.template.id.localeCompare(right.template.id));

    const resolveChannel = (channel: ClarificationChannel): PromptCandidate[] => {
      const matchingCandidates = matchingTemplates.flatMap(({ template }, templateOrder) =>
        toCandidates(normalizedIdea, template, templateOrder, channel)
      ).sort(orderCandidates);
      let resolved = deduplicateAndLimit(matchingCandidates, maxPrompts);
      if (resolved.length < minimumPrompts) {
        resolved = deduplicateAndLimit([
          ...resolved,
          ...fallbackCandidates(this.#fallback, channel)
        ], maxPrompts);
      }
      return resolved;
    };

    const design = resolveChannel("design");
    const art = resolveChannel("art");
    const allResolved = [...design, ...art].map(publicPrompt);
    const usedFallback = allResolved.some((prompt) => prompt.templateId === this.#fallback.id);

    return Object.freeze({
      idea,
      matchedTemplateIds: Object.freeze(matchingTemplates.map(({ template }) => template.id)),
      usedFallback,
      designPrompts: Object.freeze(design.map(({ text }) => text)),
      artPrompts: Object.freeze(art.map(({ text }) => text)),
      resolvedPrompts: Object.freeze(allResolved)
    });
  }
}
