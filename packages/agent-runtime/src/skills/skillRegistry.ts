import { createHash } from "node:crypto";
import type {
  ActivatedAgentSkill,
  AgentContract,
  AgentSkillActivationPolicy,
  AgentSkillAvailabilityStatus,
  AgentSkillBinding,
  AgentSkillRiskLevel,
  Artifact,
  StageId,
  Task
} from "@game-pipeline/shared-schemas";

const maxActiveSkillsPerInvocation = 3;

export interface AgentSkillDefinition {
  skillId: string;
  name: string;
  version: string;
  description: string;
  riskLevel: AgentSkillRiskLevel;
  origin: "internal_clean_room";
  requiredTools: string[];
  instructions: string[];
}

export interface AgentSkillAvailability {
  skillId: string;
  name: string;
  version: string;
  contentHash: string;
  riskLevel: AgentSkillRiskLevel;
  activationPolicy: AgentSkillActivationPolicy;
  status: AgentSkillAvailabilityStatus;
  reason: string;
}

export interface AgentSkillResolution {
  active: ActivatedAgentSkill[];
  available: AgentSkillAvailability[];
}

export interface ResolveAgentSkillsInput {
  agent: AgentContract;
  stageId: StageId;
  task?: Task;
  artifacts: Artifact[];
  recentText?: string;
  requestedSkillIds?: string[];
  disabledSkillIds?: string[];
}

interface RegisteredSkill extends AgentSkillDefinition {
  contentHash: string;
}

export class AgentSkillRegistry {
  readonly #skills = new Map<string, RegisteredSkill>();

  constructor(definitions: AgentSkillDefinition[]) {
    for (const definition of definitions) {
      assertSkillDefinition(definition);
      if (this.#skills.has(definition.skillId)) {
        throw new Error(`Duplicate Agent Skill id: ${definition.skillId}`);
      }
      const frozen = freezeSkillDefinition(definition);
      this.#skills.set(frozen.skillId, {
        ...frozen,
        contentHash: skillContentHash(frozen)
      });
    }
  }

  get(skillId: string): RegisteredSkill {
    const skill = this.#skills.get(skillId);
    if (!skill) {
      throw new Error(`Agent Skill not registered: ${skillId}`);
    }
    return cloneRegisteredSkill(skill);
  }

  list(): RegisteredSkill[] {
    return [...this.#skills.values()].map(cloneRegisteredSkill);
  }

  assertAgentBindings(agents: AgentContract[]): void {
    for (const agent of agents) {
      const seen = new Set<string>();
      for (const binding of agent.skillBindings) {
        if (seen.has(binding.skillId)) {
          throw new Error(`${agent.agentId} has duplicate Skill binding: ${binding.skillId}`);
        }
        seen.add(binding.skillId);
        const skill = this.get(binding.skillId);
        const missingTools = skill.requiredTools.filter((tool) => !agent.tools.includes(tool));
        if (missingTools.length > 0) {
          throw new Error(`${agent.agentId} cannot bind ${skill.skillId}; missing tools: ${missingTools.join(", ")}`);
        }
        if (binding.activationPolicy === "workflow_gate" && !(binding.approvedStages?.length)) {
          throw new Error(`${agent.agentId}/${skill.skillId} workflow_gate binding requires approvedStages`);
        }
      }
    }
  }

  resolve(input: ResolveAgentSkillsInput): AgentSkillResolution {
    const requested = new Set(input.requestedSkillIds ?? []);
    const disabled = new Set(input.disabledSkillIds ?? []);
    const artifactById = new Map(input.artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const taskText = normalizeText([
      input.task?.title,
      input.task?.description,
      ...(input.task?.acceptanceCriteria ?? []),
      input.recentText
    ].filter(Boolean).join("\n"));
    const inputTypes = new Set(
      (input.task?.inputArtifacts ?? []).map((artifactId) => artifactById.get(artifactId)?.type).filter((value) => value !== undefined)
    );
    const outputTypes = new Set(
      (input.task?.outputArtifacts ?? []).map((artifactId) => artifactById.get(artifactId)?.type).filter((value) => value !== undefined)
    );

    const evaluated = input.agent.skillBindings
      .map((binding) => this.evaluateBinding({ binding, input, requested, disabled, taskText, inputTypes, outputTypes }))
      .sort((left, right) => right.priority - left.priority || left.availability.skillId.localeCompare(right.availability.skillId));

    const selected = evaluated.filter((item) => item.activated).slice(0, maxActiveSkillsPerInvocation);
    const selectedIds = new Set(selected.map((item) => item.availability.skillId));
    const available = evaluated.map((item) => {
      if (item.activated && !selectedIds.has(item.availability.skillId)) {
        return {
          ...item.availability,
          status: "available" as const,
          reason: `匹配成功，但本轮最多注入 ${maxActiveSkillsPerInvocation} 个 Skill。`
        };
      }
      return item.availability;
    });
    return {
      active: selected.map((item) => item.activated).filter((item) => item !== undefined),
      available
    };
  }

  renderGuidance(activeSkills: ActivatedAgentSkill[]): string {
    return activeSkills.map((active) => {
      const definition = this.get(active.skillId);
      return [
        `### ${definition.name} (${definition.skillId}@${definition.version})`,
        `触发：${active.reason}`,
        ...definition.instructions.map((instruction) => `- ${instruction}`),
        "- Skill 只提供专业流程，不扩大 AgentContract 的工具、路径、密钥或门禁权限。"
      ].join("\n");
    }).join("\n\n");
  }

  private evaluateBinding(input: {
    binding: AgentSkillBinding;
    input: ResolveAgentSkillsInput;
    requested: Set<string>;
    disabled: Set<string>;
    taskText: string;
    inputTypes: Set<Artifact["type"]>;
    outputTypes: Set<Artifact["type"]>;
  }): { priority: number; availability: AgentSkillAvailability; activated?: ActivatedAgentSkill } {
    const { binding } = input;
    const skill = this.get(binding.skillId);
    const base = {
      skillId: skill.skillId,
      name: skill.name,
      version: skill.version,
      contentHash: skill.contentHash,
      riskLevel: skill.riskLevel,
      activationPolicy: binding.activationPolicy
    };
    if (input.disabled.has(skill.skillId)) {
      return { priority: binding.priority, availability: { ...base, status: "disabled", reason: "制作人本轮显式禁用。" } };
    }

    const stageMatches = !binding.stages?.length || binding.stages.includes(input.input.stageId);
    if (!stageMatches) {
      return { priority: binding.priority, availability: { ...base, status: "not_applicable", reason: `当前阶段 ${input.input.stageId} 不适用。` } };
    }

    const explicit = input.requested.has(skill.skillId);
    const keyword = binding.activationKeywords?.find((candidate) => input.taskText.includes(normalizeText(candidate)));
    const inputArtifact = binding.inputArtifactTypes?.find((type) => input.inputTypes.has(type));
    const outputArtifact = binding.outputArtifactTypes?.find((type) => input.outputTypes.has(type));
    const hasSelectors = Boolean(
      binding.activationKeywords?.length || binding.inputArtifactTypes?.length || binding.outputArtifactTypes?.length
    );
    const selectorMatches = explicit || Boolean(keyword || inputArtifact || outputArtifact) || (!hasSelectors && Boolean(input.input.task));
    const selectorReason = explicit
      ? "制作人显式指定。"
      : keyword
        ? `任务语义命中“${keyword}”。`
        : outputArtifact
          ? `任务输出包含 ${outputArtifact}。`
          : inputArtifact
            ? `任务输入包含 ${inputArtifact}。`
            : "当前任务属于该角色的默认专业范围。";

    if (binding.activationPolicy === "manual_only") {
      if (!explicit) {
        return { priority: binding.priority, availability: { ...base, status: "available", reason: "仅在制作人显式指定时加载。" } };
      }
      return this.activated(binding.priority, base, "producer_requested", selectorReason);
    }

    if (!selectorMatches) {
      return { priority: binding.priority, availability: { ...base, status: "not_applicable", reason: "当前任务未命中触发条件。" } };
    }

    if (binding.activationPolicy === "workflow_gate") {
      if (!binding.approvedStages?.includes(input.input.stageId)) {
        return {
          priority: binding.priority,
          availability: { ...base, status: "awaiting_approval", reason: `${selectorReason} 等待工作流批准阶段。` }
        };
      }
      return this.activated(binding.priority, base, "workflow_approved", `${selectorReason} 当前工作流阶段已批准。`);
    }

    return this.activated(binding.priority, base, explicit ? "producer_requested" : "automatic", selectorReason);
  }

  private activated(
    priority: number,
    base: Omit<AgentSkillAvailability, "status" | "reason">,
    activationSource: ActivatedAgentSkill["activationSource"],
    reason: string
  ): { priority: number; availability: AgentSkillAvailability; activated: ActivatedAgentSkill } {
    return {
      priority,
      availability: { ...base, status: "active", reason },
      activated: {
        skillId: base.skillId,
        name: base.name,
        version: base.version,
        contentHash: base.contentHash,
        riskLevel: base.riskLevel,
        activationSource,
        reason
      }
    };
  }
}

export function extractProducerSkillDirectives(
  texts: string[],
  knownSkillIds: string[]
): { requestedSkillIds: string[]; disabledSkillIds: string[] } {
  const known = new Set(knownSkillIds);
  const requested = new Set<string>();
  const disabled = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\$([a-z0-9][a-z0-9-]*)/gi)) {
      const skillId = match[1]?.toLowerCase();
      if (skillId && known.has(skillId)) requested.add(skillId);
    }
    for (const match of text.matchAll(/\$disable-skill:([a-z0-9][a-z0-9-]*)/gi)) {
      const skillId = match[1]?.toLowerCase();
      if (skillId && known.has(skillId)) disabled.add(skillId);
    }
  }
  for (const skillId of disabled) requested.delete(skillId);
  return { requestedSkillIds: [...requested], disabledSkillIds: [...disabled] };
}

function assertSkillDefinition(definition: AgentSkillDefinition): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(definition.skillId)) {
    throw new Error(`Invalid Agent Skill id: ${definition.skillId}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(definition.version)) {
    throw new Error(`Invalid Agent Skill version for ${definition.skillId}: ${definition.version}`);
  }
  if (!definition.name.trim() || !definition.description.trim() || definition.instructions.length === 0) {
    throw new Error(`Incomplete Agent Skill definition: ${definition.skillId}`);
  }
  if (definition.instructions.some((instruction) => !instruction.trim())) {
    throw new Error(`Agent Skill ${definition.skillId} contains an empty instruction`);
  }
}

function freezeSkillDefinition(definition: AgentSkillDefinition): AgentSkillDefinition {
  return Object.freeze({
    ...definition,
    requiredTools: Object.freeze([...definition.requiredTools]) as unknown as string[],
    instructions: Object.freeze([...definition.instructions]) as unknown as string[]
  });
}

function skillContentHash(definition: AgentSkillDefinition): string {
  return createHash("sha256").update(JSON.stringify({
    skillId: definition.skillId,
    name: definition.name,
    version: definition.version,
    description: definition.description,
    riskLevel: definition.riskLevel,
    origin: definition.origin,
    requiredTools: definition.requiredTools,
    instructions: definition.instructions
  })).digest("hex");
}

function cloneRegisteredSkill(skill: RegisteredSkill): RegisteredSkill {
  return {
    ...skill,
    requiredTools: [...skill.requiredTools],
    instructions: [...skill.instructions]
  };
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}
