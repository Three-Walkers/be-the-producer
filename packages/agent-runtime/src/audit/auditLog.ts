import type { AuditEvent, AuditEventId, ProjectId } from "@game-pipeline/shared-schemas";

export class InMemoryAuditLog {
  private readonly events: AuditEvent[] = [];

  append(event: AuditEvent): AuditEvent {
    this.events.push(event);
    return event;
  }

  list(projectId?: ProjectId): AuditEvent[] {
    if (!projectId) {
      return [...this.events];
    }

    return this.events.filter((event) => event.projectId === projectId);
  }

  get(eventId: AuditEventId): AuditEvent | undefined {
    return this.events.find((event) => event.eventId === eventId);
  }
}
