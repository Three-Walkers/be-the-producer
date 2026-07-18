import type {
  AgentContract,
  AgentId,
  Artifact,
  Room,
  StageId,
  StudioMessage,
  Task
} from "@game-pipeline/shared-schemas";
import { AgentRegistry } from "../agents/agentRegistry.js";

export interface RouterContext {
  room: Room;
  currentStage: StageId;
  currentTasks: Task[];
  artifacts: Artifact[];
  recentMessages: StudioMessage[];
}

export interface AgentRouteScore {
  agentId: AgentId;
  score: number;
  reasons: string[];
  required: boolean;
}

export interface RoutePlan {
  targets: AgentRouteScore[];
  orchestratorSummaryRequired: boolean;
}

const progressQueryPatterns = [
  "进度",
  "状态",
  "怎么样",
  "卡住",
  "阻塞",
  "还有什么",
  "当前",
  "现在",
  "progress",
  "status",
  "blocked"
];

export class RoleAwareRouter {
  constructor(private readonly registry: AgentRegistry) {}

  route(message: StudioMessage, context: RouterContext): RoutePlan {
    const scores = this.registry
      .list()
      .filter((agent) => context.room.participants.includes(agent.agentId))
      .map((agent) => this.scoreAgent(agent, message, context))
      .filter((score) => score.required || score.score >= context.room.routingPolicy.orchestratorReviewThreshold)
      .sort((a, b) => b.score - a.score);

    const mustRespond = scores.filter((score) => score.required);
    const reviewOnly = scores.filter((score) => !score.required);

    return {
      targets: mustRespond.length > 0 ? mustRespond : reviewOnly,
      orchestratorSummaryRequired: mustRespond.length === 0 || this.isProgressQuery(message)
    };
  }

  private scoreAgent(agent: AgentContract, message: StudioMessage, context: RouterContext): AgentRouteScore {
    let score = 0;
    const reasons: string[] = [];
    const policy = context.room.routingPolicy;

    if (message.mentions.includes(agent.agentId)) {
      score += policy.explicitMentionScore;
      reasons.push("explicit_mention");
    }

    if (context.room.participants.includes(agent.agentId)) {
      score += policy.primaryRoomScore;
      reasons.push("room_member");
    }

    if (agent.stageLeads.includes(context.currentStage)) {
      score += policy.stageLeadScore;
      reasons.push("stage_lead");
    }

    if (agent.messageTypes.includes(message.messageType)) {
      score += policy.messageTypeScore;
      reasons.push("message_type");
    }

    if (this.hasRelatedTask(agent, message, context.currentTasks)) {
      score += policy.currentTaskScore;
      reasons.push("related_task");
    }

    if (this.hasRelatedArtifact(agent, message, context.artifacts)) {
      score += policy.artifactScore;
      reasons.push("related_artifact");
    }

    if (this.wasRecentParticipant(agent.agentId, context.recentMessages)) {
      score += policy.recentParticipantScore;
      reasons.push("recent_participant");
    }

    if (this.isProgressQuery(message) && this.hasOpenTask(agent, context.currentTasks)) {
      score += policy.progressQueryScore;
      reasons.push("progress_query_open_task");
    }

    if (this.matchesAgentKeywords(agent, message.content)) {
      score += policy.messageTypeScore;
      reasons.push("role_keyword");
    }

    return {
      agentId: agent.agentId,
      score,
      reasons,
      required: score >= policy.mustRespondThreshold
    };
  }

  private hasRelatedTask(agent: AgentContract, message: StudioMessage, tasks: Task[]): boolean {
    return tasks.some(
      (task) =>
        task.ownerAgentId === agent.agentId &&
        (message.relatedTaskIds.includes(task.taskId) || task.status === "doing" || task.status === "blocked")
    );
  }

  private hasRelatedArtifact(agent: AgentContract, message: StudioMessage, artifacts: Artifact[]): boolean {
    return artifacts.some(
      (artifact) =>
        artifact.ownerAgentId === agent.agentId && message.relatedArtifactIds.includes(artifact.artifactId)
    );
  }

  private hasOpenTask(agent: AgentContract, tasks: Task[]): boolean {
    return tasks.some(
      (task) =>
        task.ownerAgentId === agent.agentId &&
        (task.status === "todo" || task.status === "doing" || task.status === "review" || task.status === "blocked")
    );
  }

  private wasRecentParticipant(agentId: AgentId, recentMessages: StudioMessage[]): boolean {
    return recentMessages.some((message) => message.senderType === "agent" && message.senderId === agentId);
  }

  private isProgressQuery(message: StudioMessage): boolean {
    const content = message.content.toLowerCase();
    return progressQueryPatterns.some((pattern) => content.includes(pattern));
  }

  private matchesAgentKeywords(agent: AgentContract, content: string): boolean {
    const normalized = content.toLowerCase();
    return agent.progressKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
  }
}
