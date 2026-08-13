export type PlaytestVerdict = "pass" | "fail" | "blocked";
export type PlaytestSeverity = "blocker" | "critical" | "major" | "minor";

export interface PlaytestCheckResult {
  checkId: string;
  label: string;
  status: "passed" | "failed" | "blocked";
  details: string;
}

export interface PlaytestDefect {
  defectId: string;
  severity: PlaytestSeverity;
  category: "runtime" | "interaction" | "dynamic_value" | "ui_layout" | "console" | "coverage";
  title: string;
  details: string;
  ownerAgentId: "gameplay_programmer" | "cocos_tech_lead" | "art_director" | "cocos_automation";
  evidencePaths: string[];
}

export interface PlaytestContractEvidence {
  schemaVersion: "1.0.0";
  playtestId: string;
  revision: number;
  path: string;
  hash: string;
  sizeBytes: number;
  runtimeProtocol: "1.0.0";
  adapterMode: "runtime_adapter" | "legacy_yarn_v1";
  runtimeContractHash?: string;
  hashVerified: boolean;
}

export interface PlaytestContractScenarioEvidence {
  scenarioId: string;
  title: string;
  required: boolean;
  passed: boolean;
  initialState: string;
  finalState: string;
  requiredStepIds: string[];
  passedStepIds: string[];
  evidencePaths: string[];
  details: string;
}

export interface PlaytestReportEvidence {
  schemaVersion?: 1 | 2;
  operationId: string;
  verdict: PlaytestVerdict;
  completedAt: string;
  buildOperationId?: string;
  checks: PlaytestCheckResult[];
  defects: PlaytestDefect[];
  evidencePaths: string[];
  contract?: PlaytestContractEvidence;
  scenarios?: PlaytestContractScenarioEvidence[];
  runtime: {
    initialState?: string;
    playingState?: string;
    terminalState?: string;
    restartedState?: string;
    consoleErrorCount: number;
    durationMs: number;
  };
}

const markerPrefix = "<!-- BTP_PLAYTEST_RESULT:";
const markerSuffix = " -->";

export function renderPlaytestMarker(result: PlaytestReportEvidence): string {
  return `${markerPrefix}${JSON.stringify(result)}${markerSuffix}`;
}

export function parsePlaytestMarker(content: string): PlaytestReportEvidence | undefined {
  const start = content.lastIndexOf(markerPrefix);
  if (start === -1) {
    return undefined;
  }
  const valueStart = start + markerPrefix.length;
  const end = content.indexOf(markerSuffix, valueStart);
  if (end === -1) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content.slice(valueStart, end)) as unknown;
    if (!isRecord(parsed) || !["pass", "fail", "blocked"].includes(String(parsed.verdict))) {
      return undefined;
    }
    return parsed as unknown as PlaytestReportEvidence;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
