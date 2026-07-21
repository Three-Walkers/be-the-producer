import { selectTeamTasks, summarizeTaskProgress, taskProgressPercent } from "/dashboard-progress.js";

const state = {
  projectId: null,
  project: null,
  rooms: [],
  activeRoomKind: "studio-main",
  projectSummaries: [],
  messages: [],
  taskBoard: null,
  artifacts: [],
  workspace: null,
  agentLoop: null,
  modelProviders: [],
  modelAssignments: [],
  modelTestResults: {},
  harnessStatuses: [],
  cocosEngine: null,
  cocosEngineTestResult: null,
  pendingAgentResponses: [],
  roomSettingsKind: null,
  selectedModelProviderId: "dashscope"
};

const presets = {
  stage1: {
    roomKind: "studio-main",
    label: "确认立项",
    pendingLabel: "确认执行立项",
    confirmToken: "执行确认：确认立项",
    expectedStages: ["concept_discussion"],
    reviewMessageType: "review",
    reviewContent: "请求门禁评审：确认立项。请策划、美术、Producer Agent 和 Orchestrator 评估准备度、阻塞和风险，不要直接推进阶段。",
    confirmMessageType: "decision_record",
    confirmContent: "执行确认：确认立项。制作人已阅读 Agent 门禁评审和风险提示，仍确认进入开发落地。"
  },
  playable: {
    roomKind: "studio-main",
    label: "首个可玩通过",
    pendingLabel: "确认执行可玩",
    confirmToken: "执行确认：首个可玩通过",
    expectedStages: ["production"],
    reviewMessageType: "review",
    reviewContent: "请求门禁评审：首个可玩通过。请程序、Cocos 自动化和 QA 评估构建、可玩性、测试报告和风险，不要直接推进阶段。",
    confirmMessageType: "decision_record",
    confirmContent: "执行确认：首个可玩通过。制作人已阅读 Agent 门禁评审和风险提示，仍确认进入发布准备。"
  },
  release: {
    roomKind: "release-room",
    label: "批准发布",
    pendingLabel: "确认执行发布",
    confirmToken: "执行确认：批准发布",
    expectedStages: ["release_preparation", "release_gate"],
    reviewMessageType: "review",
    reviewContent: "请求门禁评审：批准发布。请微信平台、QA、DevOps 和 LiveOps 评估 release 构建、发布门禁、部署回滚和上线风险，不要直接发布或推进阶段。",
    confirmMessageType: "decision_record",
    confirmContent: "执行确认：批准发布。制作人已阅读 Agent 门禁评审和风险提示，仍确认进入发布和持续运营。"
  },
  progress: {
    roomKind: "studio-main",
    label: "询问进度",
    messageType: "progress_update",
    content: "现在整体进度如何？请相关 Agent 回复当前任务、阻塞和下一步。"
  }
};

const stageLabels = {
  concept_discussion: "立项讨论",
  concept_review: "立项评审",
  production: "开发落地",
  first_playable_review: "首个可玩评审",
  release_preparation: "发布准备",
  release_gate: "发布门禁",
  production_deploy: "生产部署",
  liveops: "持续运营"
};

const roomLabels = {
  "studio-main": "主群聊",
  "design-room": "策划室",
  "art-room": "美术室",
  "engineering-room": "程序室",
  "qa-room": "测试室",
  "release-room": "发布运维室"
};

const agentLabels = {
  studio_orchestrator: "总控 Agent",
  producer: "制作人协调",
  game_designer: "策划 Agent",
  art_director: "美术导演 Agent",
  asset_production: "资产生产 Agent",
  cocos_tech_lead: "Cocos 架构 Agent",
  gameplay_programmer: "玩法程序 Agent",
  cocos_automation: "Cocos 自动化 Agent",
  qa_evaluator: "测试评估 Agent",
  wechat_platform: "微信平台 Agent",
  devops: "运维 Agent",
  liveops_analytics: "运营分析 Agent"
};

const capabilityLabels = {
  reasoning: "推理规划",
  vision: "视觉理解",
  image_generation: "图像生成",
  coding: "代码开发",
  evaluation: "测试评估"
};

const mentionCandidates = [
  { agentId: "studio_orchestrator", token: "总控", aliases: ["studio_orchestrator", "orchestrator", "调度", "主持人"] },
  { agentId: "producer", token: "制作人协调", aliases: ["producer", "producer_agent", "制作"] },
  { agentId: "game_designer", token: "策划", aliases: ["game_designer", "游戏策划", "designer"] },
  { agentId: "art_director", token: "美术", aliases: ["art_director", "美术导演", "art"] },
  { agentId: "asset_production", token: "资产", aliases: ["asset_production", "资产生产"] },
  { agentId: "cocos_tech_lead", token: "架构", aliases: ["cocos_tech_lead", "cocos", "技术负责人", "工程结构"] },
  { agentId: "gameplay_programmer", token: "程序", aliases: ["gameplay_programmer", "玩法程序", "开发"] },
  { agentId: "cocos_automation", token: "自动化", aliases: ["cocos_automation", "编辑器"] },
  { agentId: "qa_evaluator", token: "QA", aliases: ["qa_evaluator", "测试", "评估"] },
  { agentId: "wechat_platform", token: "微信平台", aliases: ["wechat_platform", "微信"] },
  { agentId: "devops", token: "运维", aliases: ["devops", "部署"] },
  { agentId: "liveops_analytics", token: "运营", aliases: ["liveops_analytics", "liveops", "数据"] }
].map((candidate) => ({
  ...candidate,
  label: agentLabels[candidate.agentId] ?? candidate.agentId
}));

const avatarThemes = {
  producer: { initial: "制", color: "#8a6a2a" },
  studio_orchestrator: { initial: "总", color: "#2f7d66" },
  game_designer: { initial: "策", color: "#4f6fb3" },
  producer_agent: { initial: "制", color: "#8a6a2a" },
  art_director: { initial: "美", color: "#b45a7f" },
  asset_production: { initial: "资", color: "#a0672b" },
  cocos_tech_lead: { initial: "架", color: "#52606d" },
  gameplay_programmer: { initial: "程", color: "#2d6d91" },
  cocos_automation: { initial: "构", color: "#5b6cbb" },
  qa_evaluator: { initial: "测", color: "#7a5aa8" },
  wechat_platform: { initial: "微", color: "#23874f" },
  devops: { initial: "运", color: "#6f6a43" },
  liveops_analytics: { initial: "数", color: "#7a6650" }
};

const teamDefinitions = [
  {
    teamId: "design",
    name: "策划团队",
    agents: ["game_designer", "producer"],
    taskOwners: ["game_designer"],
    idle: "等待项目启动，启动后先进行立项、机制和第一可玩范围讨论。"
  },
  {
    teamId: "art",
    name: "美术团队",
    agents: ["art_director", "asset_production"],
    idle: "等待项目启动，启动后确认视觉方向并进入资产生产。"
  },
  {
    teamId: "engineering",
    name: "程序团队",
    agents: ["cocos_tech_lead", "gameplay_programmer", "cocos_automation"],
    idle: "等待策划和美术基线确认后，推进 Cocos 工程、玩法实现和构建。"
  },
  {
    teamId: "qa",
    name: "测试评估团队",
    agents: ["qa_evaluator"],
    idle: "等待可玩版本生成后，执行试玩、门禁和问题评估。"
  },
  {
    teamId: "release",
    name: "发布运维团队",
    agents: ["wechat_platform", "devops", "liveops_analytics"],
    idle: "等待发布审批后，负责微信发布、部署记录、回滚和运营迭代。"
  }
];

const artifactTypeLabels = {
  gdd: "玩法方案",
  art_bible: "美术方向",
  asset_spec: "资产规格",
  asset: "美术资产",
  asset_manifest: "资产清单",
  scene_blueprint: "场景蓝图",
  source_code: "代码变更",
  build: "可玩构建",
  qa_report: "测试报告",
  bug_report: "问题报告",
  deployment_report: "部署记录",
  rollback_plan: "回滚方案",
  release_notes: "运营迭代说明"
};

const statusLabels = {
  todo: "待办",
  doing: "进行中",
  review: "评审中",
  blocked: "阻塞",
  done: "完成",
  cancelled: "已取消",
  draft: "草案",
  submitted: "已提交",
  approved: "已批准",
  change_requested: "需调整",
  rejected: "已驳回",
  superseded: "已替换"
};

const $ = (selector) => document.querySelector(selector);
const settingsDialog = $("#settings-dialog");
const startConfirmDialog = $("#start-confirm-dialog");
const deleteConfirmDialog = $("#delete-confirm-dialog");
const artifactPreviewDialog = $("#artifact-preview-dialog");
const roomSettingsDialog = $("#room-settings-dialog");
const messageContentInput = $("#message-content");
const mentionSuggestions = $("#mention-suggestions");
let pendingStartProjectId = null;
let pendingStartMode = "start";
let pendingDeleteProjectId = null;
let activePreviewArtifactId = null;
let mentionState = {
  active: false,
  start: -1,
  query: "",
  selectedIndex: 0,
  candidates: []
};

$("#open-settings").addEventListener("click", () => {
  settingsDialog.showModal();
});

$("#close-settings").addEventListener("click", () => {
  settingsDialog.close();
});

settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog) {
    settingsDialog.close();
  }
});

$("#cancel-start-project").addEventListener("click", () => {
  pendingStartProjectId = null;
  pendingStartMode = "start";
  startConfirmDialog.close();
});

$("#confirm-start-project").addEventListener("click", async () => {
  if (!pendingStartProjectId) {
    return;
  }

  const button = $("#confirm-start-project");
  const projectId = pendingStartProjectId;
  const mode = pendingStartMode;
  button.disabled = true;
  button.textContent = mode === "resume" ? "继续中" : "启动中";
  try {
    await startProject(projectId, {
      resumed: mode === "resume",
      restarted: mode === "restart"
    });
    pendingStartProjectId = null;
    pendingStartMode = "start";
    startConfirmDialog.close();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = mode === "resume" ? "确认继续" : "确认启动";
  }
});

startConfirmDialog.addEventListener("click", (event) => {
  if (event.target === startConfirmDialog) {
    pendingStartProjectId = null;
    pendingStartMode = "start";
    startConfirmDialog.close();
  }
});

$("#cancel-delete-project").addEventListener("click", () => {
  pendingDeleteProjectId = null;
  deleteConfirmDialog.close();
});

$("#confirm-delete-project").addEventListener("click", async () => {
  if (!pendingDeleteProjectId) {
    return;
  }

  const button = $("#confirm-delete-project");
  const projectId = pendingDeleteProjectId;
  button.disabled = true;
  button.textContent = "删除中";
  try {
    await request(`/projects/${projectId}`, {
      method: "DELETE"
    });
    if (state.projectId === projectId) {
      clearCurrentProject();
    }
    pendingDeleteProjectId = null;
    deleteConfirmDialog.close();
    await loadProjects({ autoOpenLatest: !state.projectId });
    showToast("项目已删除。");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "确认删除";
  }
});

deleteConfirmDialog.addEventListener("click", (event) => {
  if (event.target === deleteConfirmDialog) {
    pendingDeleteProjectId = null;
    deleteConfirmDialog.close();
  }
});

$("#close-artifact-preview").addEventListener("click", () => {
  closeArtifactPreview();
});

$("#open-artifact-finder").addEventListener("click", () => {
  if (!activePreviewArtifactId) {
    showToast("请先选择一个交付物。");
    return;
  }
  openArtifactInFinder(activePreviewArtifactId).catch((error) => showToast(error.message));
});

artifactPreviewDialog.addEventListener("click", (event) => {
  if (event.target === artifactPreviewDialog) {
    closeArtifactPreview();
  }
});

$("#close-room-settings").addEventListener("click", () => {
  closeRoomSettings();
});

roomSettingsDialog.addEventListener("click", (event) => {
  if (event.target === roomSettingsDialog) {
    closeRoomSettings();
  }
});

$("#model-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#model-settings-form button[type='submit']");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "保存中";
  try {
    const providerId = $("#model-provider-select").value;
    const apiKey = $("#model-api-key").value.trim();
    const payload = {
      label: $("#model-provider-label").value.trim(),
      protocol: $("#model-provider-protocol").value,
      baseUrl: $("#model-base-url").value.trim(),
      defaultModel: $("#model-name").value.trim()
    };
    if (apiKey) {
      payload.apiKey = apiKey;
    }

    await request(`/settings/model-providers/${encodeURIComponent(providerId)}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    $("#model-api-key").value = "";
    await loadModelProviders();
    button.textContent = "已保存";
  } catch (error) {
    button.textContent = "失败";
    showToast(error.message);
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 1200);
  }
});

$("#model-provider-select").addEventListener("change", () => {
  state.selectedModelProviderId = $("#model-provider-select").value;
  renderModelSettings();
});

$("#add-model-provider").addEventListener("click", async () => {
  const button = $("#add-model-provider");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "新增中";
  try {
    const count = state.modelProviders.filter((provider) => provider.isCustom).length + 1;
    const result = await request("/settings/model-providers", {
      method: "POST",
      body: JSON.stringify({
        label: `自定义模型连接 ${count}`,
        protocol: "openai-compatible",
        baseUrl: "",
        defaultModel: ""
      })
    });
    state.selectedModelProviderId = result.provider.providerId;
    await loadModelProviders();
    $("#model-provider-label").focus();
    button.textContent = "已新增";
  } catch (error) {
    button.textContent = "失败";
    showToast(error.message);
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 1200);
  }
});

$("#remove-model-provider").addEventListener("click", async () => {
  const button = $("#remove-model-provider");
  const providerId = $("#model-provider-select").value;
  const selected = state.modelProviders.find((provider) => provider.providerId === providerId);
  if (!selected?.isCustom || selected.providerId === "custom") {
    showToast("只能移除通过“新增连接”创建的模型连接。");
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "移除中";
  try {
    await request(`/settings/model-provider-profiles/${encodeURIComponent(providerId)}`, {
      method: "DELETE"
    });
    delete state.modelTestResults[providerId];
    state.selectedModelProviderId = "dashscope";
    await loadModelProviders();
    button.textContent = "已移除";
  } catch (error) {
    button.textContent = "失败";
    showToast(error.message);
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 1200);
  }
});

$("#clear-model-key").addEventListener("click", async () => {
  const button = $("#clear-model-key");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "清除中";
  try {
    const providerId = $("#model-provider-select").value;
    await request(`/settings/model-providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE"
    });
    $("#model-api-key").value = "";
    delete state.modelTestResults[providerId];
    await loadModelProviders();
    button.textContent = "已清除";
  } catch (error) {
    button.textContent = "失败";
    showToast(error.message);
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 1200);
  }
});

$("#test-model-provider").addEventListener("click", async () => {
  const button = $("#test-model-provider");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "测试中";
  try {
    const providerId = $("#model-provider-select").value;
    const result = await request(`/settings/model-provider-tests/${encodeURIComponent(providerId)}`, {
      method: "POST"
    });
    state.modelTestResults[providerId] = result.result;
    renderModelTestStatus();
    showToast(result.result.message);
  } catch (error) {
    const providerId = $("#model-provider-select").value;
    const selected = state.modelProviders.find((provider) => provider.providerId === providerId);
    const result = {
      ok: false,
      providerId,
      label: selected?.label ?? providerId,
      latencyMs: 0,
      testedAt: new Date().toISOString(),
      message: error.message
    };
    state.modelTestResults[providerId] = result;
    renderModelTestStatus();
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

$("#test-claude-harness").addEventListener("click", async () => {
  const button = $("#test-claude-harness");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "检测中";
  try {
    const response = await request("/settings/agent-harness-tests/claude-cli", { method: "POST" });
    state.harnessStatuses = [response.result];
    renderHarnessStatus();
    showToast(response.result.message);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

$("#cocos-engine-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#cocos-engine-form button[type='submit']");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "保存中";
  try {
    const response = await request("/settings/cocos-engine", {
      method: "PUT",
      body: JSON.stringify({
        executablePath: $("#cocos-executable-path").value.trim(),
        version: $("#cocos-engine-version").value.trim(),
        platform: $("#cocos-engine-platform").value,
        buildConfigPath: $("#cocos-build-config-path").value.trim(),
        timeoutMs: Math.max(1, Number($("#cocos-build-timeout").value) || 20) * 60 * 1000
      })
    });
    state.cocosEngine = response.config;
    state.cocosEngineTestResult = null;
    renderCocosEngineSettings();
    button.textContent = "已保存";
  } catch (error) {
    button.textContent = "失败";
    showToast(error.message);
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 1200);
  }
});

$("#detect-cocos-engine").addEventListener("click", async () => {
  const button = $("#detect-cocos-engine");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "检测中";
  try {
    const response = await request("/settings/cocos-engine-detect", { method: "POST" });
    state.cocosEngine = response.config;
    state.cocosEngineTestResult = null;
    renderCocosEngineSettings();
    showToast(`已检测到 Cocos Creator：${response.config.executablePath}`);
  } catch (error) {
    state.cocosEngineTestResult = { ok: false, message: error.message };
    renderCocosEngineStatus();
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

$("#test-cocos-engine").addEventListener("click", async () => {
  const button = $("#test-cocos-engine");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "测试中";
  try {
    const response = await request("/settings/cocos-engine-test", { method: "POST" });
    state.cocosEngineTestResult = response.result;
    if (response.result.version && state.cocosEngine) {
      state.cocosEngine.version = response.result.version;
    }
    renderCocosEngineSettings();
    showToast(response.result.message);
  } catch (error) {
    state.cocosEngineTestResult = { ok: false, message: error.message };
    renderCocosEngineStatus();
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const name = $("#project-name").value.trim();
    const idea = $("#project-idea").value.trim();
    if (!name || !idea) {
      showToast("项目名称和 idea 都需要填写。");
      return;
    }

    const created = await request("/projects", {
      method: "POST",
      body: JSON.stringify({ name, idea, producerId: "producer_web" })
    });
    state.projectId = created.project.projectId;
    state.project = created.project;
    state.rooms = created.rooms;
    state.workspace = created.workspace;
    state.activeRoomKind = "studio-main";
    await refreshProject();
    await loadProjects({ autoOpenLatest: false });
    showToast("项目已创建。点击项目列表里的启动图标后，Agents 才会开始执行。");
  } catch (error) {
    showToast(error.message);
  }
});

$("#send-message").addEventListener("click", async () => {
  try {
    const content = messageContentInput.value.trim();
    if (!content) {
      showToast("先输入要发送给 Agent 群聊的内容。");
      return;
    }

    ensureProject();
    if (!canAgentsReceiveMessages()) {
      throw new Error("项目未运行。请先启动或继续项目后再让 Agents 评审或执行。");
    }

    const payload = {
      roomKind: state.activeRoomKind,
      messageType: $("#message-type").value,
      content
    };
    messageContentInput.value = "";
    hideMentionSuggestions();
    await sendProducerMessage(payload);
  } catch (error) {
    showToast(error.message);
  }
});

messageContentInput.addEventListener("input", updateMentionSuggestions);
messageContentInput.addEventListener("click", updateMentionSuggestions);
messageContentInput.addEventListener("keyup", (event) => {
  if (["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) {
    return;
  }
  updateMentionSuggestions();
});
messageContentInput.addEventListener("keydown", (event) => {
  if (!mentionState.active) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveMentionSelection(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveMentionSelection(-1);
    return;
  }

  if (event.key === "Enter" || event.key === "Tab") {
    const candidate = mentionState.candidates[mentionState.selectedIndex];
    if (candidate) {
      event.preventDefault();
      insertMentionCandidate(candidate);
    }
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    hideMentionSuggestions();
  }
});

document.addEventListener("mousedown", (event) => {
  if (event.target === messageContentInput || mentionSuggestions.contains(event.target)) {
    return;
  }
  hideMentionSuggestions();
});

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      const presetId = button.dataset.preset;
      const preset = presets[presetId];
      if (!preset) {
        return;
      }

      if (!canAgentsReceiveMessages()) {
        showToast("项目未运行。请先在项目列表点击启动或继续图标，让 Agents 进入工作状态。");
        return;
      }

      const payload = buildPresetMessage(presetId, preset);
      state.activeRoomKind = payload.roomKind;
      renderProjectHeader();
      renderRooms();
      renderMessages();
      await sendProducerMessage(payload);
    } catch (error) {
      showToast(error.message);
    }
  });
});

async function sendProducerMessage(input) {
  ensureProject();
  if (!canAgentsReceiveMessages()) {
    throw new Error("项目未运行。请先启动或继续项目后再让 Agents 评审或执行。");
  }

  const optimisticMessageId = appendOptimisticProducerMessage(input);
  const pendingResponseId = appendAgentTypingIndicator(input);
  try {
    await request(`/projects/${state.projectId}/messages`, {
      method: "POST",
      body: JSON.stringify(input)
    });
    await refreshProject();
  } catch (error) {
    removeAgentTypingIndicator(pendingResponseId);
    markOptimisticMessageFailed(optimisticMessageId);
    throw error;
  } finally {
    removeAgentTypingIndicator(pendingResponseId);
  }
}

function appendOptimisticProducerMessage(input) {
  const activeRoom = state.rooms.find((room) => room.kind === (input.roomKind ?? state.activeRoomKind)) ?? state.rooms[0];
  const messageId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const message = {
    messageId,
    projectId: state.projectId,
    roomId: input.roomId ?? activeRoom?.roomId ?? state.activeRoomKind,
    senderType: "producer",
    senderId: state.project?.producerId ?? "producer_web",
    messageType: input.messageType ?? "plan_submission",
    content: input.content,
    mentions: input.mentions ?? [],
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata: {
      clientStatus: "pending"
    },
    createdAt: new Date().toISOString()
  };
  state.messages = [...state.messages, message];
  renderRooms();
  renderMessages();
  return messageId;
}

function appendAgentTypingIndicator(input) {
  const activeRoom = state.rooms.find((room) => room.kind === (input.roomKind ?? state.activeRoomKind)) ?? state.rooms[0];
  const targetAgentIds = mentionedAgentIds(input.content);
  const indicator = {
    indicatorId: `typing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: state.projectId,
    roomId: input.roomId ?? activeRoom?.roomId ?? state.activeRoomKind,
    targetAgentIds,
    createdAt: new Date().toISOString()
  };
  state.pendingAgentResponses = [...state.pendingAgentResponses, indicator];
  renderMessages();
  return indicator.indicatorId;
}

function removeAgentTypingIndicator(indicatorId) {
  const next = state.pendingAgentResponses.filter((indicator) => indicator.indicatorId !== indicatorId);
  if (next.length === state.pendingAgentResponses.length) {
    return;
  }

  state.pendingAgentResponses = next;
  renderMessages();
}

function markOptimisticMessageFailed(messageId) {
  state.messages = state.messages.map((message) => {
    if (message.messageId !== messageId) {
      return message;
    }

    return {
      ...message,
      metadata: {
        ...(message.metadata ?? {}),
        clientStatus: "failed"
      }
    };
  });
  renderRooms();
  renderMessages();
}

function buildPresetMessage(presetId, preset) {
  if (!preset.confirmToken) {
    return preset;
  }

  if (hasPendingGateReview(presetId)) {
    return {
      roomKind: preset.roomKind,
      messageType: preset.confirmMessageType,
      content: preset.confirmContent
    };
  }

  return {
    roomKind: preset.roomKind,
    messageType: preset.reviewMessageType,
    content: preset.reviewContent
  };
}

async function refreshProject() {
  ensureProject();
  const [project, rooms, messages, taskBoard, artifacts, workspace, agentLoop] = await Promise.all([
    request(`/projects/${state.projectId}`),
    request(`/projects/${state.projectId}/rooms`),
    request(`/projects/${state.projectId}/messages`),
    request(`/projects/${state.projectId}/task-board`),
    request(`/projects/${state.projectId}/artifacts`),
    request(`/projects/${state.projectId}/workspace-tree`),
    request(`/projects/${state.projectId}/agent-loop`)
  ]);

  state.project = project.project;
  state.rooms = rooms.rooms;
  state.messages = messages.messages;
  state.taskBoard = taskBoard.taskBoard;
  state.artifacts = artifacts.artifacts;
  state.workspace = workspace;
  state.agentLoop = agentLoop.agentLoop;
  render();
}

async function loadProjects({ autoOpenLatest = true } = {}) {
  const listing = await request("/projects");
  state.projectSummaries = listing.projects;
  renderProjectList();
  if (autoOpenLatest && !state.projectId && state.projectSummaries.length > 0) {
    await loadProject(state.projectSummaries[0].projectId);
  }
}

async function loadProject(projectId) {
  state.projectId = projectId;
  state.activeRoomKind = "studio-main";
  state.pendingAgentResponses = [];
  await refreshProject();
}

function render() {
  renderModelSettings();
  renderProjectHeader();
  renderProjectList();
  renderQuickActions();
  renderRooms();
  renderMessages();
  renderTaskBoard();
  renderArtifacts();
  renderWorkspace();
}

function renderQuickActions() {
  document.querySelectorAll("[data-preset]").forEach((button) => {
    const presetId = button.dataset.preset;
    const preset = presets[presetId];
    if (!preset) {
      return;
    }

    const pending = Boolean(preset.confirmToken && hasPendingGateReview(presetId));
    button.textContent = pending ? preset.pendingLabel : preset.label;
    button.classList.toggle("pending-confirm", pending);
    button.title = pending ? `已收到 Agent 风险评审。再次点击会发送「${preset.confirmToken}」。` : "";
  });
}

function hasPendingGateReview(presetId) {
  const preset = presets[presetId];
  if (!preset?.confirmToken || !canAgentsReceiveMessages()) {
    return false;
  }

  if (preset.expectedStages && !preset.expectedStages.includes(state.project.currentStage)) {
    return false;
  }

  const reviewNeedle = `二次确认口令：${preset.confirmToken}`;
  let latestReview = -1;
  let latestExecution = -1;
  state.messages.forEach((message, index) => {
    if (message.senderType === "agent" && message.content.includes(reviewNeedle)) {
      latestReview = index;
    }
    if (message.senderType === "producer" && message.content.includes(preset.confirmToken)) {
      latestExecution = index;
    }
  });

  return latestReview !== -1 && latestReview > latestExecution;
}

function updateMentionSuggestions() {
  const mention = findActiveMention(messageContentInput.value, messageContentInput.selectionStart ?? 0);
  if (!mention) {
    hideMentionSuggestions();
    return;
  }

  const candidates = filterMentionCandidates(mention.query);
  if (!candidates.length) {
    hideMentionSuggestions();
    return;
  }

  mentionState = {
    active: true,
    start: mention.start,
    query: mention.query,
    selectedIndex: Math.min(mentionState.selectedIndex, candidates.length - 1),
    candidates
  };
  renderMentionSuggestions();
}

function findActiveMention(value, cursorPosition) {
  const beforeCursor = value.slice(0, cursorPosition);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex === -1) {
    return null;
  }

  const query = beforeCursor.slice(atIndex + 1);
  if (/[\s，。！？、,.!?;；:：()[\]{}（）【】]/.test(query)) {
    return null;
  }

  return { start: atIndex, query };
}

function filterMentionCandidates(query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return mentionCandidates;
  }

  return mentionCandidates.filter((candidate) => {
    const searchable = [candidate.token, candidate.label, candidate.agentId, ...candidate.aliases]
      .join(" ")
      .toLowerCase();
    return searchable.includes(normalizedQuery);
  });
}

function renderMentionSuggestions() {
  mentionSuggestions.hidden = false;
  mentionSuggestions.innerHTML = mentionState.candidates
    .map((candidate, index) => `<button class="mention-suggestion${index === mentionState.selectedIndex ? " active" : ""}" data-mention-index="${index}" type="button" role="option" aria-selected="${index === mentionState.selectedIndex}">
      <strong>@${escapeHtml(candidate.token)}</strong>
      <span>${escapeHtml(candidate.label)}</span>
      <small>${escapeHtml(candidate.agentId)}</small>
    </button>`)
    .join("");

  mentionSuggestions.querySelectorAll("[data-mention-index]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const candidate = mentionState.candidates[Number(button.dataset.mentionIndex)];
      if (candidate) {
        insertMentionCandidate(candidate);
      }
    });
  });
}

function moveMentionSelection(delta) {
  if (!mentionState.candidates.length) {
    return;
  }

  const nextIndex = (mentionState.selectedIndex + delta + mentionState.candidates.length) % mentionState.candidates.length;
  mentionState = {
    ...mentionState,
    selectedIndex: nextIndex
  };
  renderMentionSuggestions();
}

function insertMentionCandidate(candidate) {
  const cursorPosition = messageContentInput.selectionStart ?? messageContentInput.value.length;
  const before = messageContentInput.value.slice(0, mentionState.start);
  const after = messageContentInput.value.slice(cursorPosition);
  const insertion = `@${candidate.token} `;
  messageContentInput.value = `${before}${insertion}${after}`;
  const nextCursor = before.length + insertion.length;
  messageContentInput.focus();
  messageContentInput.setSelectionRange(nextCursor, nextCursor);
  hideMentionSuggestions();
}

function hideMentionSuggestions() {
  mentionState = {
    active: false,
    start: -1,
    query: "",
    selectedIndex: 0,
    candidates: []
  };
  mentionSuggestions.hidden = true;
  mentionSuggestions.innerHTML = "";
}

async function loadModelProviders() {
  const [settings, harnessSettings, cocosSettings] = await Promise.all([
    request("/settings/model-providers"),
    request("/settings/agent-harnesses"),
    request("/settings/cocos-engine")
  ]);
  state.modelProviders = settings.providers;
  state.modelAssignments = settings.assignments ?? [];
  state.harnessStatuses = harnessSettings.harnesses ?? [];
  state.cocosEngine = cocosSettings.config ?? null;
  if (!state.modelProviders.some((provider) => provider.providerId === state.selectedModelProviderId)) {
    state.selectedModelProviderId = state.modelProviders[0]?.providerId ?? "openai";
  }
  renderModelSettings();
}

function renderModelSettings() {
  const select = $("#model-provider-select");
  if (!state.modelProviders.length) {
    select.innerHTML = "";
    $("#model-provider-label").value = "";
    $("#model-provider-protocol").value = "openai-compatible";
    $("#model-config-summary").textContent = "未加载";
    $("#model-test-status").className = "model-test-status idle";
    $("#model-test-status").innerHTML = '<span class="test-light"></span><span>正在读取模型配置</span>';
    $("#model-provider-status").innerHTML = '<div class="empty-state compact">正在读取模型配置</div>';
    $("#agent-model-assignments").innerHTML = '<div class="empty-state compact">正在读取角色模型分配</div>';
    return;
  }

  select.innerHTML = state.modelProviders
    .map((provider) => `<option value="${escapeHtml(provider.providerId)}">${escapeHtml(providerDisplayName(provider))}</option>`)
    .join("");
  select.value = state.selectedModelProviderId;

  const selected = state.modelProviders.find((provider) => provider.providerId === state.selectedModelProviderId) ?? state.modelProviders[0];
  state.selectedModelProviderId = selected.providerId;
  $("#model-provider-label").value = selected.label ?? "";
  $("#model-provider-protocol").value = selected.protocol ?? "openai-compatible";
  $("#model-base-url").value = selected.baseUrl ?? "";
  $("#model-name").value = selected.defaultModel ?? "";
  $("#model-config-summary").textContent = `${state.modelProviders.filter((provider) => provider.hasApiKey).length}/${state.modelProviders.length} 已配置`;
  $("#remove-model-provider").disabled = !selected.isCustom || selected.providerId === "custom";
  renderModelTestStatus();
  $("#model-provider-status").innerHTML = state.modelProviders
    .map((provider) => {
      const status = provider.hasApiKey ? `已配置 · ${provider.keyFingerprint}` : "未配置";
      const active = provider.providerId === state.selectedModelProviderId ? " active" : "";
      const details = [protocolLabel(provider.protocol), provider.defaultModel || "未设置默认模型"].join(" · ");
      return `<button class="provider-row${active}" data-provider-id="${escapeHtml(provider.providerId)}" type="button">
        <span class="provider-row-main">
          <span><span class="status-dot ${provider.hasApiKey ? "ready" : ""}"></span>${escapeHtml(provider.label)}</span>
          <small>${escapeHtml(details)}</small>
        </span>
        <span>${escapeHtml(status)}</span>
      </button>`;
    })
    .join("");

  $("#model-provider-status").querySelectorAll("[data-provider-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedModelProviderId = button.dataset.providerId;
      renderModelSettings();
    });
  });
  renderAgentAssignments();
  renderHarnessStatus();
  renderCocosEngineSettings();
}

function renderCocosEngineSettings() {
  const config = state.cocosEngine;
  if (!config) {
    $("#cocos-engine-summary").textContent = "未加载";
    return;
  }
  $("#cocos-executable-path").value = config.executablePath ?? "";
  $("#cocos-engine-version").value = config.version ?? "3.8.x";
  $("#cocos-engine-platform").value = config.platform ?? "wechatgame";
  $("#cocos-build-config-path").value = config.buildConfigPath ?? "";
  $("#cocos-build-timeout").value = String(Math.max(1, Math.round((config.timeoutMs ?? 1_200_000) / 60_000)));
  $("#cocos-engine-summary").textContent = config.executableExists
    ? `${config.version} · 已就绪`
    : config.executablePath
      ? "路径无效"
      : "未配置";
  renderCocosEngineStatus();
}

function renderCocosEngineStatus() {
  const container = $("#cocos-engine-status");
  const result = state.cocosEngineTestResult;
  const config = state.cocosEngine;
  if (result) {
    container.className = `model-test-status ${result.ok ? "success" : "failure"}`;
    const latency = result.latencyMs ? ` · ${result.latencyMs}ms` : "";
    container.innerHTML = `<span class="test-light"></span><span>${escapeHtml(result.message)}${escapeHtml(latency)}</span>`;
    return;
  }
  if (config?.executableExists) {
    container.className = "model-test-status idle";
    container.innerHTML = `<span class="test-light"></span><span>已找到 ${escapeHtml(config.executablePath)}，尚未启动真实 CLI 测试。</span>`;
    return;
  }
  container.className = config?.executablePath ? "model-test-status failure" : "model-test-status idle";
  container.innerHTML = `<span class="test-light"></span><span>${config?.executablePath ? `可执行文件不存在或不可执行：${escapeHtml(config.executablePath)}` : "未配置 Cocos Creator。Agent 构建会立即报告环境阻塞。"}</span>`;
}

function renderHarnessStatus() {
  const container = $("#claude-harness-status");
  const status = state.harnessStatuses.find((candidate) => candidate.harnessId === "claude-cli");
  if (!status) {
    container.className = "model-test-status idle";
    container.innerHTML = '<span class="test-light"></span><span>尚未检测 Claude Code CLI。</span>';
    return;
  }
  container.className = `model-test-status ${status.available ? "success" : "failure"}`;
  container.innerHTML = `<span class="test-light"></span><span>${escapeHtml(status.message)}</span>`;
}

function renderModelTestStatus() {
  const container = $("#model-test-status");
  const providerId = state.selectedModelProviderId;
  const result = state.modelTestResults[providerId];
  const provider = state.modelProviders.find((candidate) => candidate.providerId === providerId);
  if (!result) {
    container.className = "model-test-status idle";
    container.innerHTML = `<span class="test-light"></span><span>${escapeHtml(providerDisplayName(provider) ?? providerId)} 尚未测试连通性。</span>`;
    return;
  }

  container.className = `model-test-status ${result.ok ? "success" : "failure"}`;
  const latency = result.latencyMs ? ` · ${result.latencyMs}ms` : "";
  container.innerHTML = `<span class="test-light"></span><span>${escapeHtml(result.message)}${escapeHtml(latency)}</span>`;
}

function renderAgentAssignments() {
  const container = $("#agent-model-assignments");
  $("#assignment-summary").textContent = `${state.modelAssignments.length} 个角色`;
  if (!state.modelAssignments.length) {
    container.innerHTML = '<div class="empty-state compact">暂无角色模型分配</div>';
    return;
  }

  container.innerHTML = state.modelAssignments
    .map((assignment) => {
      const displayName = agentName(assignment.agentId);
      const capability = capabilityLabels[assignment.capability] ?? assignment.capability;
      const options = state.modelProviders
        .map(
          (provider) =>
            `<option value="${escapeHtml(provider.providerId)}" ${provider.providerId === assignment.providerId ? "selected" : ""}>${escapeHtml(providerDisplayName(provider))}</option>`
        )
        .join("");
      return `<div class="assignment-row" data-agent-id="${escapeHtml(assignment.agentId)}">
        <div class="assignment-agent">
          ${avatarMarkupWithUrl(assignment.agentId, displayName, assignment.avatarUrl)}
          <div class="assignment-meta">
            <strong>${escapeHtml(displayName)}</strong>
            <span>${escapeHtml(assignment.agentId)} · ${escapeHtml(capability)}</span>
          </div>
        </div>
        <select data-assignment-harness aria-label="执行内核">
          <option value="claude-cli" ${assignment.harnessId === "claude-cli" ? "selected" : ""}>Claude CLI</option>
          <option value="direct-api" ${assignment.harnessId === "direct-api" ? "selected" : ""}>直接 API</option>
        </select>
        <select data-assignment-provider>${options}</select>
        <input data-assignment-model value="${escapeHtml(assignment.model)}" placeholder="使用连接默认模型" />
        <div class="avatar-upload-control">
          <span data-avatar-preview>${avatarMarkupWithUrl(assignment.agentId, displayName, assignment.avatarUrl)}</span>
          <input data-assignment-avatar type="hidden" value="${escapeHtml(assignment.avatarUrl ?? "")}" />
          <input data-avatar-file type="file" accept="image/*" hidden />
          <button data-pick-avatar class="avatar-upload-button" type="button">上传头像</button>
          <button data-clear-avatar class="avatar-clear-button" type="button" aria-label="清除头像" title="清除头像">×</button>
        </div>
        <button data-save-assignment type="button">保存</button>
      </div>`;
    })
    .join("");

  container.querySelectorAll("[data-pick-avatar]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest("[data-agent-id]");
      row.querySelector("[data-avatar-file]").click();
    });
  });

  container.querySelectorAll("[data-avatar-file]").forEach((input) => {
    input.addEventListener("change", async () => {
      const row = input.closest("[data-agent-id]");
      const file = input.files?.[0];
      input.value = "";
      if (!file) {
        return;
      }

      try {
        const avatarDataUrl = await readAvatarFileAsDataUrl(file);
        row.querySelector("[data-assignment-avatar]").value = avatarDataUrl;
        updateAssignmentAvatarPreview(row, avatarDataUrl);
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  container.querySelectorAll("[data-clear-avatar]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest("[data-agent-id]");
      row.querySelector("[data-assignment-avatar]").value = "";
      updateAssignmentAvatarPreview(row, "");
    });
  });

  container.querySelectorAll("[data-save-assignment]").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("[data-agent-id]");
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "保存中";
      try {
        const providerId = row.querySelector("[data-assignment-provider]").value;
        const harnessId = row.querySelector("[data-assignment-harness]").value;
        const model = row.querySelector("[data-assignment-model]").value;
        const avatarUrl = row.querySelector("[data-assignment-avatar]").value;
        await request(`/settings/model-assignments/${encodeURIComponent(row.dataset.agentId)}`, {
          method: "PUT",
          body: JSON.stringify({
            harnessId,
            providerId,
            model,
            avatarUrl
          })
        });
        const assignment = state.modelAssignments.find((candidate) => candidate.agentId === row.dataset.agentId);
        if (assignment) {
          assignment.harnessId = harnessId;
          assignment.providerId = providerId;
          assignment.model = model.trim();
          assignment.avatarUrl = avatarUrl.trim();
        }
        button.textContent = "已保存";
        showToast(`${agentName(row.dataset.agentId)}的模型与执行内核配置已保存。`);
        renderMessages();
      } catch (error) {
        button.textContent = "失败";
        showToast(error.message);
      } finally {
        setTimeout(() => {
          button.disabled = false;
          button.textContent = originalText;
        }, 1200);
      }
    });
  });
}

function updateAssignmentAvatarPreview(row, avatarUrl) {
  const agentId = row.dataset.agentId;
  const displayName = agentName(agentId);
  row.querySelectorAll("[data-avatar-preview]").forEach((container) => {
    container.innerHTML = avatarMarkupWithUrl(agentId, displayName, avatarUrl);
  });
  const agentAvatar = row.querySelector(".assignment-agent .role-avatar");
  if (agentAvatar) {
    agentAvatar.outerHTML = avatarMarkupWithUrl(agentId, displayName, avatarUrl);
  }
}

async function readAvatarFileAsDataUrl(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error("请选择图片文件作为头像。");
  }

  const source = await readFileAsDataUrl(file);
  return resizeAvatarImage(source, file.type);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(new Error("头像文件读取失败。")));
    reader.readAsDataURL(file);
  });
}

function resizeAvatarImage(source, mimeType) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const size = 160;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("当前浏览器无法处理头像图片。"));
        return;
      }

      const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
      const sourceX = Math.max(0, (image.naturalWidth - sourceSize) / 2);
      const sourceY = Math.max(0, (image.naturalHeight - sourceSize) / 2);
      context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
      const outputType = mimeType === "image/png" ? "image/png" : "image/jpeg";
      resolve(canvas.toDataURL(outputType, 0.86));
    });
    image.addEventListener("error", () => reject(new Error("头像图片无法解析，请换一张图片。")));
    image.src = source;
  });
}

function renderProjectHeader() {
  $("#project-title").textContent = state.project?.name ?? "未创建";
  $("#active-room-title").textContent = `当前房间 · ${activeRoomName()}`;
  if (!state.project) {
    $("#project-stage").textContent = "等待 idea";
    renderAgentLoopStatus();
    return;
  }

  $("#project-stage").textContent = isProjectStarted()
    ? `${stageLabels[state.project.currentStage] ?? state.project.currentStage} · ${executionLabel(currentExecutionStatus())}`
    : "未启动";
  renderAgentLoopStatus();
}

function renderAgentLoopStatus() {
  const container = $("#agent-loop-status");
  const text = $("#agent-loop-status-text");
  const loop = state.agentLoop;
  const status = loop?.status ?? (state.project?.executionStatus === "paused" ? "paused" : "idle");
  container.className = `agent-loop-status ${status}`;
  if (!loop) {
    text.textContent = "Agent Loop 未启动";
    container.title = "Agent Loop 尚未建立运行状态。";
    return;
  }
  if (status === "running") {
    const names = (loop.activeAgentIds ?? []).map(agentName);
    text.textContent = names.length ? `${names.join("、")} 工作中 · 第 ${loop.iteration} 轮` : `Agent Loop 调度中 · 第 ${loop.iteration} 轮`;
  } else if (status === "waiting_for_producer") {
    text.textContent = "等待制作人";
  } else if (status === "blocked") {
    text.textContent = "Loop 阻塞";
  } else if (status === "error") {
    text.textContent = "Loop 异常";
  } else if (status === "paused") {
    text.textContent = "Agent Loop 已暂停";
  } else {
    text.textContent = "Agent Loop 空闲";
  }
  container.title = loop.waitingReason ?? loop.lastError ?? `Agent Loop：${status}`;
}

function renderProjectList() {
  const list = $("#project-list");
  $("#project-list-summary").textContent = String(state.projectSummaries.length);
  if (!state.projectSummaries.length) {
    list.innerHTML = '<div class="empty-state compact">暂无已保存项目</div>';
    return;
  }

  list.innerHTML = state.projectSummaries
    .map((project) => {
      const active = project.projectId === state.projectId ? " active" : "";
      const stage = stageLabels[project.currentStage] ?? project.currentStage;
      const execution = project.executionStatus ?? "draft";
      const startLabel = execution === "paused" ? "继续项目" : "启动项目";
      const actionButton =
        execution === "running"
          ? `<button class="project-action-button pause-icon-button" data-pause-project type="button" title="暂停项目" aria-label="暂停项目">${pauseIcon()}</button>`
          : `<button class="project-action-button" data-start-project type="button" title="${startLabel}" aria-label="${startLabel}">${playIcon()}</button>`;
      return `<div class="project-row${active}" data-project-id="${escapeHtml(project.projectId)}">
        <button class="project-open" data-open-project type="button" title="打开项目" aria-label="打开项目">
          <span>
            <strong>${escapeHtml(project.name)}</strong>
            <small>${escapeHtml(stage)} · ${escapeHtml(executionLabel(execution))} · ${new Date(project.savedAt).toLocaleString()}</small>
          </span>
        </button>
        <div class="project-actions">
          ${actionButton}
          <button class="project-action-button danger-icon-button" data-delete-project type="button" title="删除项目" aria-label="删除项目">${trashIcon()}</button>
        </div>
      </div>`;
    })
    .join("");

  list.querySelectorAll("[data-open-project]").forEach((button) => {
    button.addEventListener("click", () => {
      loadProject(button.closest("[data-project-id]").dataset.projectId).catch((error) => showToast(error.message));
    });
  });
  list.querySelectorAll("[data-start-project]").forEach((button) => {
    button.addEventListener("click", () => {
      requestStartProject(button.closest("[data-project-id]").dataset.projectId);
    });
  });
  list.querySelectorAll("[data-pause-project]").forEach((button) => {
    button.addEventListener("click", () => {
      pauseProject(button.closest("[data-project-id]").dataset.projectId).catch((error) => showToast(error.message));
    });
  });
  list.querySelectorAll("[data-delete-project]").forEach((button) => {
    button.addEventListener("click", () => {
      requestDeleteProject(button.closest("[data-project-id]").dataset.projectId);
    });
  });
}

function requestStartProject(projectId) {
  const target = state.projectSummaries.find((project) => project.projectId === projectId);
  const running = state.projectSummaries.find((project) => project.executionStatus === "running");
  if (target?.executionStatus === "paused" && (!running || running.projectId === projectId)) {
    startProject(projectId, { resumed: true }).catch((error) => showToast(error.message));
    return;
  }

  pendingStartProjectId = projectId;
  pendingStartMode = target?.executionStatus === "paused" ? "resume" : target?.executionStatus === "draft" ? "start" : "restart";
  const base =
    pendingStartMode === "resume"
      ? `即将继续「${target?.name ?? projectId}」，Agents 会接着当前进度工作。`
      : `即将启动「${target?.name ?? projectId}」，Agents 会从该项目的初始 idea 开始流程。`;
  const interruption = running && running.projectId !== projectId
    ? `当前正在执行「${running.name}」，确认后会先暂停它，再切换到该项目。`
    : pendingStartMode === "start"
      ? "确认后会创建阶段任务并开始立项讨论。"
      : "确认后会清空该项目当前运行态并重新开始。";
  $("#start-confirm-message").textContent = `${base}${interruption}`;
  $("#confirm-start-project").textContent = pendingStartMode === "resume" ? "确认继续" : "确认启动";
  startConfirmDialog.showModal();
}

async function startProject(projectId, { resumed = false, restarted = false } = {}) {
  const started = await request(`/projects/${projectId}/start`, {
    method: "POST"
  });
  state.projectId = started.project.projectId;
  state.project = started.project;
  state.rooms = started.rooms;
  state.workspace = started.workspace;
  state.activeRoomKind = "studio-main";
  await loadProjects({ autoOpenLatest: false });
  await refreshProject();
  showToast(resumed ? "项目已继续，Agents 已恢复工作。" : restarted ? "项目已启动，Agents 已从初始 idea 重新开始。" : "项目已启动，Agents 已进入工作状态。");
}

async function pauseProject(projectId) {
  const paused = await request(`/projects/${projectId}/pause`, {
    method: "POST"
  });
  if (state.projectId === projectId) {
    state.project = paused.project;
    state.rooms = paused.rooms;
    state.workspace = paused.workspace;
    if (paused.taskBoard) {
      state.taskBoard = paused.taskBoard;
    }
  }
  await loadProjects({ autoOpenLatest: false });
  if (state.projectId === projectId) {
    await refreshProject();
  } else {
    renderProjectList();
  }
  showToast("项目已暂停，Agents 不会处理新的制作人指令。");
}

function requestDeleteProject(projectId) {
  const target = state.projectSummaries.find((project) => project.projectId === projectId);
  pendingDeleteProjectId = projectId;
  $("#delete-confirm-message").textContent = `确认删除「${target?.name ?? projectId}」？删除后会移除本地进度、任务记录和工作空间文件。`;
  deleteConfirmDialog.showModal();
}

function executionLabel(status) {
  switch (status) {
    case "running":
      return "执行中";
    case "paused":
      return "已暂停";
    case "completed":
      return "已完成";
    case "draft":
    default:
      return "未启动";
  }
}

function clearCurrentProject() {
  state.projectId = null;
  state.project = null;
  state.rooms = [];
  state.activeRoomKind = "studio-main";
  state.messages = [];
  state.pendingAgentResponses = [];
  state.taskBoard = null;
  state.artifacts = [];
  state.workspace = null;
  state.roomSettingsKind = null;
  if (roomSettingsDialog.open) {
    roomSettingsDialog.close();
  }
  render();
}

function renderRooms() {
  const roomList = $("#room-list");
  if (!state.rooms.length) {
    roomList.innerHTML = '<div class="empty-state">暂无房间</div>';
    return;
  }

  roomList.innerHTML = state.rooms
    .map((room) => {
      const count = state.messages.filter((message) => message.roomId === room.roomId).length;
      const active = room.kind === state.activeRoomKind ? " active" : "";
      return `<div class="room-row${active}">
        <button class="room-button room-select-button" data-room-kind="${escapeHtml(room.kind)}" type="button">
          <span>${escapeHtml(roomLabels[room.kind] ?? room.name)}</span>
          <span>${count}</span>
        </button>
        <button class="room-settings-button" data-room-settings="${escapeHtml(room.kind)}" type="button" aria-label="设置${escapeHtml(roomLabels[room.kind] ?? room.name)}成员" title="管理房间成员">⚙</button>
      </div>`;
    })
    .join("");

  roomList.querySelectorAll("[data-room-kind]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeRoomKind = button.dataset.roomKind;
      renderProjectHeader();
      renderRooms();
      renderMessages();
    });
  });
  roomList.querySelectorAll("[data-room-settings]").forEach((button) => {
    button.addEventListener("click", () => {
      openRoomSettings(button.dataset.roomSettings);
    });
  });
}

function openRoomSettings(roomKind) {
  const room = state.rooms.find((candidate) => candidate.kind === roomKind);
  if (!room) {
    showToast("房间不存在或尚未加载。");
    return;
  }
  state.roomSettingsKind = roomKind;
  renderRoomSettings();
  roomSettingsDialog.showModal();
}

function closeRoomSettings() {
  state.roomSettingsKind = null;
  roomSettingsDialog.close();
}

function renderRoomSettings() {
  const room = state.rooms.find((candidate) => candidate.kind === state.roomSettingsKind);
  const list = $("#room-member-list");
  if (!room) {
    $("#room-settings-title").textContent = "房间成员";
    $("#room-settings-summary").textContent = "房间不存在或尚未加载。";
    list.innerHTML = '<div class="empty-state compact">暂无可管理成员</div>';
    return;
  }

  const participants = new Set(room.participants ?? []);
  $("#room-settings-title").textContent = roomLabels[room.kind] ?? room.name;
  $("#room-settings-summary").textContent = `${participants.size} 个 Agent 在房间内；移出后该角色不会再收到本房间的自动路由。`;
  const candidates = [...mentionCandidates].sort((left, right) => Number(participants.has(right.agentId)) - Number(participants.has(left.agentId)));
  list.innerHTML = candidates
    .map((candidate) => {
      const present = participants.has(candidate.agentId);
      const action = present ? "remove" : "invite";
      const actionLabel = present ? "移出房间" : "邀请加入";
      return `<div class="room-member-row">
        ${avatarMarkup(candidate.agentId, candidate.label)}
        <div class="room-member-identity">
          <strong>${escapeHtml(candidate.label)}</strong>
          <small>${escapeHtml(candidate.agentId)}</small>
        </div>
        <span class="room-member-status ${present ? "present" : "absent"}">${present ? "房间内" : "未加入"}</span>
        <button class="room-member-action ${action}" data-room-agent="${escapeHtml(candidate.agentId)}" data-room-action="${action}" type="button" aria-label="${actionLabel}${escapeHtml(candidate.label)}" title="${actionLabel}">${present ? "−" : "+"}</button>
      </div>`;
    })
    .join("");

  list.querySelectorAll("[data-room-agent]").forEach((button) => {
    button.addEventListener("click", async () => {
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "…";
      try {
        await updateRoomMembership(room.kind, button.dataset.roomAgent, button.dataset.roomAction);
      } catch (error) {
        showToast(error.message);
        button.disabled = false;
        button.textContent = originalText;
      }
    });
  });
}

async function updateRoomMembership(roomKind, agentId, action) {
  const result = await request(`/projects/${state.projectId}/rooms/${encodeURIComponent(roomKind)}/participants`, {
    method: "PATCH",
    body: JSON.stringify({ agentId, action })
  });
  state.rooms = result.rooms;
  const messages = await request(`/projects/${state.projectId}/messages`);
  state.messages = messages.messages;
  renderProjectHeader();
  renderRooms();
  renderMessages();
  renderRoomSettings();
  showToast(action === "invite" ? "Agent 已加入房间。" : "Agent 已移出房间。");
}

function renderMessages() {
  const activeRoom = state.rooms.find((room) => room.kind === state.activeRoomKind);
  const messages = activeRoom ? state.messages.filter((message) => message.roomId === activeRoom.roomId) : state.messages;
  const pendingResponses = activeRoom
    ? state.pendingAgentResponses.filter((indicator) => indicator.roomId === activeRoom.roomId)
    : state.pendingAgentResponses;
  const list = $("#message-list");
  const scrollContainer = list.closest(".chat-panel");
  const shouldStickToBottom = scrollContainer ? isNearScrollBottom(scrollContainer) : true;
  if (!messages.length && !pendingResponses.length) {
    list.className = "message-list empty-state";
    list.textContent = "当前房间还没有消息。";
    return;
  }

  list.className = "message-list";
  list.innerHTML = [
    ...messages.map((message) => ({ type: "message", message })),
    ...pendingResponses.map((indicator) => ({ type: "typing", indicator }))
  ]
    .map((item) => {
      if (item.type === "typing") {
        return renderTypingIndicator(item.indicator);
      }

      const { message } = item;
      const senderClass = message.senderType === "producer" ? "producer" : "agent";
      const senderId = message.senderType === "producer" ? "producer" : message.senderId;
      const sender = message.senderType === "producer" ? "制作人" : agentName(message.senderId);
      const clientStatus = message.metadata?.clientStatus;
      const statusText = clientStatus === "pending" ? " · 发送中" : clientStatus === "failed" ? " · 发送失败" : "";
      return `<article class="message ${senderClass} ${clientStatus ? `message-${escapeHtml(clientStatus)}` : ""}">
        ${avatarMarkup(senderId, sender)}
        <div class="message-body">
          <div class="message-meta">
            <span>${escapeHtml(sender)} · ${escapeHtml(message.messageType)}${escapeHtml(statusText)}</span>
            <span>${new Date(message.createdAt).toLocaleTimeString()}</span>
          </div>
          <div class="message-content">${renderMessageContent(message.content)}</div>
          ${renderClaimVerifications(message)}
        </div>
      </article>`;
    })
    .join("");
  list.querySelectorAll("[data-open-workspace-path]").forEach((button) => {
    button.addEventListener("click", () => {
      openWorkspacePath(button.dataset.openWorkspacePath).catch((error) => showToast(error.message));
    });
  });
  if (scrollContainer && shouldStickToBottom) {
    requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
  }
}

function isNearScrollBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

function renderMessageContent(content) {
  return renderMarkdown(String(content ?? ""));
}

function renderMarkdown(text) {
  const codeBlockPattern = /```([A-Za-z0-9_-]+)?\n?([\s\S]*?)```/g;
  let cursor = 0;
  let html = "";

  for (const match of text.matchAll(codeBlockPattern)) {
    html += renderMarkdownBlocks(text.slice(cursor, match.index));
    const language = match[1] ? ` data-language="${escapeHtml(match[1])}"` : "";
    html += `<pre class="message-code-block"${language}><code>${escapeHtml(match[2] ?? "")}</code></pre>`;
    cursor = (match.index ?? 0) + match[0].length;
  }

  html += renderMarkdownBlocks(text.slice(cursor));
  return html || "";
}

function renderMarkdownBlocks(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderMarkdownBlocks(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push(`<p>${paragraphLines.map((paragraphLine) => renderInlineMarkdown(paragraphLine)).join("<br>")}</p>`);
  }

  return blocks.join("");
}

function isMarkdownBlockStart(line) {
  return /^(#{1,6})\s+/.test(line) || /^\s*[-*_]{3,}\s*$/.test(line) || /^\s*>\s?/.test(line) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line);
}

function renderInlineMarkdown(text) {
  const rawText = String(text ?? "");
  const codePattern = /`([^`\n]+)`/g;
  let cursor = 0;
  let html = "";

  for (const match of rawText.matchAll(codePattern)) {
    html += renderInlineTextSegment(rawText.slice(cursor, match.index));
    const codeText = match[1] ?? "";
    const candidate = normalizeWorkspacePathCandidate(codeText);
    html += candidate ? workspacePathLink(candidate.path, candidate.label) : `<code class="message-inline-code">${escapeHtml(codeText)}</code>`;
    cursor = (match.index ?? 0) + match[0].length;
  }

  html += renderInlineTextSegment(rawText.slice(cursor));
  return html;
}

function renderInlineTextSegment(text) {
  const pathPattern =
    /(?:\.\/)?(?:agents|shared|docs|assets|artifacts|outputs|builds|release|releases|intermediate|cocos|settings)\/[A-Za-z0-9._~@%+\-/]+|(?:\.\/)?[A-Za-z0-9._~@%+-]+\/[A-Za-z0-9._~@%+\-/]*[A-Za-z0-9._~@%+-]\.[A-Za-z0-9]{2,10}/g;
  let cursor = 0;
  let html = "";
  for (const match of text.matchAll(pathPattern)) {
    const raw = match[0];
    const candidate = normalizeWorkspacePathCandidate(raw);
    if (!candidate) {
      continue;
    }

    html += renderInlineEmphasis(text.slice(cursor, match.index));
    html += workspacePathLink(candidate.path, candidate.label);
    cursor = (match.index ?? 0) + raw.length;
  }

  html += renderInlineEmphasis(text.slice(cursor));
  return html;
}

function renderInlineEmphasis(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n][\s\S]*?[^_\n])__/g, "<strong>$1</strong>");
}

function normalizeWorkspacePathCandidate(value) {
  const original = String(value ?? "");
  let candidate = original.trim();
  if (!candidate || candidate.includes("://") || candidate.startsWith("/") || candidate.includes("..")) {
    return undefined;
  }

  candidate = candidate.replace(/^\.\/+/, "");
  const trimmed = candidate.replace(/[，。；、,;:!?！？)\]}>）】》”’]+$/g, "");
  if (!trimmed || !trimmed.includes("/") || trimmed.includes("..")) {
    return undefined;
  }

  const startsWithWorkspaceRoot = /^(agents|shared|docs|assets|artifacts|outputs|builds|release|releases|intermediate|cocos|settings)\//.test(trimmed);
  const hasFileExtension = /\.[A-Za-z0-9]{2,10}$/.test(trimmed);
  if (!startsWithWorkspaceRoot && !hasFileExtension) {
    return undefined;
  }

  return {
    path: trimmed,
    label: original.slice(0, original.indexOf(trimmed) + trimmed.length) || trimmed
  };
}

function workspacePathLink(path, label) {
  return `<button class="workspace-path-link" type="button" data-open-workspace-path="${escapeHtml(path)}" title="打开精确路径 ${escapeHtml(path)}">${escapeHtml(label)}</button>`;
}

function renderClaimVerifications(message) {
  const claims = Array.isArray(message.metadata?.claimVerifications) ? message.metadata.claimVerifications : [];
  if (!claims.length) {
    return "";
  }

  return `<div class="claim-verification-list">
    ${claims
      .map((claim) => {
        const verdict = claim.verdict ?? "insufficient";
        return `<div class="claim-verification claim-${escapeHtml(verdict)}">
          <span>${escapeHtml(claimVerdictLabel(verdict))}</span>
          <small>${escapeHtml(claim.reason ?? "未记录验证说明。")}</small>
          ${renderClaimRepairMeta(claim)}
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderClaimRepairMeta(claim) {
  const metadata = claim.metadata ?? {};
  if (!metadata.repairId && !metadata.repairTaskId) {
    return "";
  }

  const status = metadata.repairStatus === "resolved" ? "已关闭" : "待补证";
  const action = repairActionLabel(metadata.repairAction);
  const taskId = typeof metadata.repairTaskId === "string" ? metadata.repairTaskId : "";
  const nextStep = typeof metadata.repairNextStep === "string" ? metadata.repairNextStep : "";
  const nearestPath = typeof metadata.nearestArtifactPath === "string" ? metadata.nearestArtifactPath : "";
  return `<div class="claim-repair-meta">
    <span>修复状态：${escapeHtml(status)}${taskId ? ` · ${escapeHtml(taskId)}` : ""}</span>
    ${action ? `<small>处理动作：${escapeHtml(action)}</small>` : ""}
    ${nearestPath ? `<small>最近实际产物：${workspacePathLink(nearestPath, nearestPath)}</small>` : ""}
    ${nextStep ? `<small>${escapeHtml(nextStep)}</small>` : ""}
  </div>`;
}

function repairActionLabel(action) {
  switch (action) {
    case "supply_evidence":
      return "补齐工具证据";
    case "correct_claim":
      return "更正声明或补齐原路径";
    default:
      return "";
  }
}

function claimVerdictLabel(verdict) {
  switch (verdict) {
    case "verified":
      return "已验证";
    case "mismatch":
      return "声明不成立";
    case "insufficient":
    default:
      return "缺少证据";
  }
}

function renderTypingIndicator(indicator) {
  const targetNames = indicator.targetAgentIds.map((agentId) => agentName(agentId));
  const sender = targetNames.length ? targetNames.join("、") : "相关 Agent";
  const senderId = indicator.targetAgentIds[0] ?? "agent_typing";
  return `<article class="message agent message-typing">
    ${avatarMarkup(senderId, sender)}
    <div class="message-body">
      <div class="message-meta">
        <span>${escapeHtml(sender)} · 正在输入</span>
        <span>${new Date(indicator.createdAt).toLocaleTimeString()}</span>
      </div>
      <div class="typing-indicator" aria-label="${escapeHtml(sender)} 正在输入">
        <span></span><span></span><span></span>
      </div>
    </div>
  </article>`;
}

function renderTaskBoard() {
  const board = $("#task-board");
  if (!isProjectStarted()) {
    $("#task-summary").textContent = "未启动";
    board.innerHTML = `<div class="producer-empty-panel">
      <strong>项目尚未启动</strong>
      <span>点击项目列表中的启动图标并确认后，Agents 才会生成任务和进入执行状态。</span>
    </div>`;
    return;
  }

  if (!state.taskBoard || state.taskBoard.total === 0) {
    $("#task-summary").textContent = "0";
    board.innerHTML = '<div class="producer-empty-panel"><strong>暂无任务</strong><span>等待 Agent 创建阶段任务。</span></div>';
    return;
  }

  const buckets = state.taskBoard.buckets;
  $("#task-summary").textContent = `${state.taskBoard.total} 项 · 完成 ${buckets.done}`;
  board.innerHTML = state.taskBoard.taskGroups
    .map((group) => `<section class="task-group">
      <div class="task-title">
        <span>${escapeHtml(group.title)}</span>
        <span class="status-pill status-${escapeHtml(group.status)}">${escapeHtml(localStatus(group.status))} · ${taskProgressPercent(group)}%</span>
      </div>
      ${group.tasks
        .map((task) => `<div class="task-item">
          <strong>${escapeHtml(task.title)}</strong>
          <div>${escapeHtml(agentName(task.ownerAgentId))} · <span class="status-${escapeHtml(task.status)}">${escapeHtml(localStatus(task.status))}</span> · ${taskProgressPercent(task)}%</div>
          ${task.blockers.length ? `<div>阻塞：${escapeHtml(task.blockers.join("；"))}</div>` : ""}
        </div>`)
        .join("")}
    </section>`)
    .join("");
}

function renderArtifacts() {
  if (!isProjectStarted()) {
    $("#artifact-summary").textContent = "待启动";
    $("#artifact-list").innerHTML = `<div class="producer-empty-panel">
      <strong>暂无可评审交付物</strong>
      <span>项目启动后，这里只展示需要制作人查看或审批的交付内容，不展示内部文档路径。</span>
    </div>`;
    return;
  }

  const deliverables = state.artifacts.filter((artifact) => artifact.status !== "superseded" && artifact.status !== "rejected");
  $("#artifact-summary").textContent = String(deliverables.length);
  $("#artifact-list").innerHTML =
    deliverables
      .map((artifact) => `<div class="deliverable-row" data-artifact-id="${escapeHtml(artifact.artifactId)}">
        <button class="deliverable-item" data-preview-artifact type="button" title="预览交付物">
          <div>
            <strong>${escapeHtml(deliverableName(artifact))}</strong>
            <span>${escapeHtml(agentName(artifact.ownerAgentId))} · ${escapeHtml(stageLabels[artifact.stageId] ?? artifact.stageId)}</span>
          </div>
          <span class="status-pill status-${escapeHtml(artifact.status)}">${escapeHtml(localStatus(artifact.status))}</span>
        </button>
        <button class="deliverable-action-button" data-open-artifact type="button" title="在 Finder 打开" aria-label="在 Finder 打开">${folderIcon()}</button>
      </div>`)
      .join("") || `<div class="producer-empty-panel">
        <strong>暂无可评审交付物</strong>
        <span>Agent 完成阶段输出后会在这里出现。</span>
      </div>`;

  $("#artifact-list").querySelectorAll("[data-preview-artifact]").forEach((button) => {
    button.addEventListener("click", () => {
      previewArtifact(button.closest("[data-artifact-id]").dataset.artifactId).catch((error) => showToast(error.message));
    });
  });
  $("#artifact-list").querySelectorAll("[data-open-artifact]").forEach((button) => {
    button.addEventListener("click", () => {
      openArtifactInFinder(button.closest("[data-artifact-id]").dataset.artifactId).catch((error) => showToast(error.message));
    });
  });
}

async function previewArtifact(artifactId) {
  ensureProject();
  activePreviewArtifactId = artifactId;
  const artifact = state.artifacts.find((candidate) => candidate.artifactId === artifactId);
  $("#artifact-preview-title").textContent = artifact ? deliverableName(artifact) : "交付物预览";
  $("#artifact-preview-path").textContent = "正在读取本地工作空间...";
  $("#artifact-preview-body").innerHTML = '<div class="producer-empty-panel"><strong>正在加载</strong><span>正在读取交付物预览。</span></div>';
  if (!artifactPreviewDialog.open) {
    artifactPreviewDialog.showModal();
  }

  const preview = await request(`/projects/${state.projectId}/artifacts/${encodeURIComponent(artifactId)}/preview`);
  renderArtifactPreview(preview);
}

function renderArtifactPreview(preview) {
  const artifact = preview.artifact;
  activePreviewArtifactId = artifact.artifactId;
  $("#artifact-preview-title").textContent = deliverableName(artifact);
  $("#artifact-preview-path").textContent = preview.target?.relativePath ?? artifact.path;
  $("#open-artifact-finder").disabled = !preview.target?.exists;
  if (!preview.previewable) {
    $("#artifact-preview-body").innerHTML = `<div class="producer-empty-panel">
      <strong>暂不支持内嵌预览</strong>
      <span>${escapeHtml(preview.reason ?? "该交付物需要在本地应用中查看。")}</span>
    </div>`;
    return;
  }

  const languageClass = preview.language ? ` artifact-preview-${escapeHtml(preview.language)}` : "";
  $("#artifact-preview-body").innerHTML = `<pre class="artifact-preview-document${languageClass}">${escapeHtml(preview.content ?? "")}</pre>`;
}

async function openArtifactInFinder(artifactId) {
  ensureProject();
  await request(`/projects/${state.projectId}/artifacts/${encodeURIComponent(artifactId)}/open`, {
    method: "POST"
  });
  showToast("已在 Finder 中打开交付物位置。");
}

async function openWorkspacePath(path) {
  ensureProject();
  try {
    const result = await request(`/projects/${state.projectId}/workspace/open`, {
      method: "POST",
      body: JSON.stringify({ path })
    });
    showToast(result.exact === false ? `已打开父目录：${result.target?.relativePath ?? path}` : "已在 Finder 中打开本地资源。");
  } catch (error) {
    const nearestTarget = error.payload?.details?.nearestTarget;
    if (nearestTarget?.exists) {
      showToast(error.message, {
        label: "打开父目录",
        onClick: () => openWorkspaceParent(path)
      });
      return;
    }

    showToast(error.message);
  }
}

async function openWorkspaceParent(path) {
  ensureProject();
  const result = await request(`/projects/${state.projectId}/workspace/open`, {
    method: "POST",
    body: JSON.stringify({ path, allowFallback: true })
  });
  showToast(`已打开父目录：${result.target?.relativePath ?? path}`);
}

function closeArtifactPreview() {
  activePreviewArtifactId = null;
  artifactPreviewDialog.close();
}

function renderWorkspace() {
  $("#workspace-root").textContent = isProjectStarted() ? executionLabel(currentExecutionStatus()) : "制作人视图";

  if (!state.project) {
    $("#workspace-tree").innerHTML = '<div class="producer-empty-panel"><strong>暂无项目</strong><span>创建项目后，这里会展示各团队最新进展。</span></div>';
    return;
  }

  if (!isProjectStarted()) {
    $("#workspace-tree").innerHTML = teamDefinitions
      .map((team) => `<div class="team-progress-item">
        <div class="team-progress-head">
          <strong>${escapeHtml(team.name)}</strong>
          <span class="status-pill status-todo">待启动</span>
        </div>
        <p>${escapeHtml(team.idle)}</p>
      </div>`)
      .join("");
    return;
  }

  $("#workspace-tree").innerHTML = teamDefinitions
    .map((team) => renderTeamProgress(team))
    .join("");
}

function renderTeamProgress(team) {
  const taskOwners = team.taskOwners ?? team.agents;
  const tasks = selectTeamTasks(collectTaskItems(), taskOwners);
  const recentMessage = [...state.messages]
    .reverse()
    .find((message) => team.agents.includes(message.senderId) && message.metadata?.generatedBy !== "claim_repair_guardian");
  const activeTask = pickActiveTask(tasks);
  const { doneCount, blockedCount, progressPercent } = summarizeTaskProgress(tasks);
  const status = blockedCount > 0 ? "blocked" : activeTask?.status ?? (doneCount > 0 ? "done" : "todo");
  const headline = activeTask
    ? `${localStatus(activeTask.status)}：${activeTask.title}`
    : recentMessage
      ? "暂无进行中任务，已记录最近沟通。"
      : team.idle;
  const recent = recentMessage ? summarizeText(recentMessage.content, 72) : "暂无最新发言";
  const agents = team.agents.map((agentId) => agentName(agentId)).join("、");

  return `<div class="team-progress-item">
    <div class="team-progress-head">
      <strong>${escapeHtml(team.name)}</strong>
      <span class="status-pill status-${escapeHtml(status)}">${escapeHtml(localStatus(status))}</span>
    </div>
    <p>${escapeHtml(headline)}</p>
    <div class="team-progress-bar" aria-label="${escapeHtml(team.name)}进度">
      <span style="width: ${progressPercent}%"></span>
    </div>
    <div class="team-progress-meta">
      <span>${tasks.length ? `${doneCount}/${tasks.length} 项完成` : "暂无任务"}</span>
      <span>${progressPercent}%</span>
    </div>
    <small>成员：${escapeHtml(agents)}</small>
    <small>最新：${escapeHtml(recent)}</small>
  </div>`;
}

function collectTaskItems() {
  if (!state.taskBoard) {
    return [];
  }

  const items = [];
  const visit = (task) => {
    items.push(task);
    (task.subtasks ?? []).forEach(visit);
  };
  state.taskBoard.taskGroups.forEach((group) => {
    group.tasks.forEach(visit);
  });
  return items;
}

function pickActiveTask(tasks) {
  return (
    tasks.find((task) => task.status === "blocked") ??
    tasks.find((task) => task.status === "doing") ??
    tasks.find((task) => task.status === "review") ??
    tasks.find((task) => task.status === "todo") ??
    tasks[0]
  );
}

function currentExecutionStatus() {
  return state.project?.executionStatus ?? "draft";
}

function isProjectStarted() {
  return ["running", "paused", "completed"].includes(currentExecutionStatus());
}

function canAgentsReceiveMessages() {
  return currentExecutionStatus() === "running";
}

function activeRoomName() {
  const room = state.rooms.find((candidate) => candidate.kind === state.activeRoomKind);
  return roomLabels[room?.kind ?? state.activeRoomKind] ?? room?.name ?? roomLabels[state.activeRoomKind] ?? "主群聊";
}

function mentionedAgentIds(content) {
  const lowerContent = String(content).toLowerCase();
  return mentionCandidates
    .filter((candidate) => {
      const tokens = [candidate.token, candidate.agentId, candidate.label, ...candidate.aliases];
      return tokens.some((token) => lowerContent.includes(`@${String(token).toLowerCase()}`));
    })
    .map((candidate) => candidate.agentId);
}

function avatarMarkup(agentId, label) {
  return avatarMarkupWithUrl(agentId, label, avatarUrlFor(agentId));
}

function avatarMarkupWithUrl(agentId, label, avatarUrl) {
  const theme = avatarThemes[agentId] ?? fallbackAvatarTheme(label);
  const image = isAvatarImageUrl(avatarUrl) ? `<img src="${escapeHtml(avatarUrl)}" alt="" />` : escapeHtml(theme.initial);
  return `<span class="role-avatar" style="--avatar-bg: ${escapeHtml(theme.color)}" aria-hidden="true">${image}</span>`;
}

function avatarUrlFor(agentId) {
  if (agentId === "producer") {
    return "";
  }

  const assignment = state.modelAssignments.find((candidate) => candidate.agentId === agentId);
  const avatarUrl = assignment?.avatarUrl?.trim() ?? "";
  return isAvatarImageUrl(avatarUrl) ? avatarUrl : "";
}

function isAvatarImageUrl(value) {
  return /^(https?:\/\/|\/|data:image\/)/i.test(value);
}

function fallbackAvatarTheme(label) {
  const text = String(label || "A").trim();
  return {
    initial: text.slice(0, 1).toUpperCase(),
    color: "#667085"
  };
}

function providerDisplayName(provider) {
  if (!provider) {
    return "";
  }
  const model = provider.defaultModel?.trim();
  return model ? `${provider.label} · ${model}` : provider.label;
}

function protocolLabel(protocol) {
  switch (protocol) {
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Gemini";
    case "openai-compatible":
    default:
      return "OpenAI-compatible";
  }
}

function agentName(agentId) {
  return agentLabels[agentId] ?? agentId;
}

function localStatus(status) {
  return statusLabels[status] ?? status;
}

function deliverableName(artifact) {
  const type = artifactTypeLabels[artifact.type] ?? artifact.type;
  const version = artifact.version ? ` v${artifact.version}` : "";
  return `${type}${version}`;
}

function summarizeText(text, limit) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `Request failed: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function ensureProject() {
  if (!state.projectId) {
    throw new Error("请先创建项目。");
  }
}

function showToast(message, action) {
  const toast = $("#toast");
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      toast.hidden = true;
      action.onClick();
    });
    toast.appendChild(button);
  }
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, action ? 7000 : 2400);
}

function playIcon() {
  return '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><path d="M8 5v14l11-7z" fill="currentColor"></path></svg>';
}

function pauseIcon() {
  return '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z" fill="currentColor"></path></svg>';
}

function folderIcon() {
  return '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1H3V6Zm0 5h18l-2 8H5l-2-8Z" fill="currentColor"></path></svg>';
}

function trashIcon() {
  return '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 6h2v9h-2V9Zm4 0h2v9h-2V9ZM7 9h2v10h8V9h2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9Z" fill="currentColor"></path></svg>';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

render();
loadModelProviders().catch((error) => showToast(error.message));
loadProjects().catch((error) => showToast(error.message));

let backgroundRefreshInFlight = false;
setInterval(() => {
  if (!state.projectId || currentExecutionStatus() !== "running" || backgroundRefreshInFlight) {
    return;
  }
  backgroundRefreshInFlight = true;
  refreshProject()
    .catch((error) => {
      if (error.status !== 404) {
        console.warn("后台刷新项目失败", error);
      }
    })
    .finally(() => {
      backgroundRefreshInFlight = false;
    });
}, 1500);
