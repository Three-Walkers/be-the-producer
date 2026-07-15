import type { AgentId, ProjectId, Room, RoomKind, RoutingPolicy, StageId } from "@game-pipeline/shared-schemas";
import { defaultAgentContracts } from "../agents/defaultAgents.js";

export const defaultRoutingPolicy: RoutingPolicy = {
  explicitMentionScore: 100,
  primaryRoomScore: 30,
  currentTaskScore: 40,
  artifactScore: 35,
  messageTypeScore: 30,
  stageLeadScore: 25,
  recentParticipantScore: 10,
  progressQueryScore: 30,
  mustRespondThreshold: 60,
  orchestratorReviewThreshold: 40
};

const roomNames: Record<RoomKind, string> = {
  "studio-main": "#studio-main",
  "design-room": "#design-room",
  "art-room": "#art-room",
  "engineering-room": "#engineering-room",
  "qa-room": "#qa-room",
  "release-room": "#release-room"
};

const roomStageScopes: Partial<Record<RoomKind, StageId>> = {
  "design-room": "concept_discussion",
  "art-room": "production",
  "engineering-room": "production",
  "qa-room": "first_playable_review",
  "release-room": "release_preparation"
};

export function createDefaultRooms(projectId: ProjectId, createdAt = new Date().toISOString()): Room[] {
  const roomKinds = Object.keys(roomNames) as RoomKind[];

  return roomKinds.map((kind) => {
    const room: Room = {
      roomId: `${projectId}:${kind}`,
      projectId,
      kind,
      name: roomNames[kind],
      participants: participantsForRoom(kind),
      routingPolicy: defaultRoutingPolicy,
      createdAt
    };
    const stageScope = roomStageScopes[kind];
    return stageScope ? { ...room, stageScope } : room;
  });
}

function participantsForRoom(roomKind: RoomKind): AgentId[] {
  return defaultAgentContracts
    .filter((agent) => agent.roomMemberships.includes(roomKind))
    .map((agent) => agent.agentId);
}
