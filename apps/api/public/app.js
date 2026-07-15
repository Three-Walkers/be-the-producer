const state = {
  projectId: null,
  project: null,
  rooms: [],
  activeRoomKind: "studio-main",
  messages: [],
  taskBoard: null,
  artifacts: [],
  workspace: null,
  modelProviders: [],
  selectedModelProviderId: "openai"
};

const presets = {
  stage1: {
    roomKind: "studio-main",
    messageType: "decision_record",
    content: "确认立项：玩法、美术方向和第一可玩范围都同意，进入开发落地。"
  },
  playable: {
    roomKind: "studio-main",
    messageType: "decision_record",
    content: "首个可玩版本通过，接受当前核心循环，进入发布准备。"
  },
  release: {
    roomKind: "release-room",
    messageType: "decision_record",
    content: "确认发布上线，批准 release。"
  },
  progress: {
    roomKind: "studio-main",
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

const $ = (selector) => document.querySelector(selector);

$("#model-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const providerId = $("#model-provider-select").value;
    const apiKey = $("#model-api-key").value.trim();
    const payload = {
      baseUrl: $("#model-base-url").value.trim(),
      defaultModel: $("#model-name").value.trim()
    };
    if (apiKey) {
      payload.apiKey = apiKey;
    }

    await request(`/settings/model-providers/${providerId}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    $("#model-api-key").value = "";
    await loadModelProviders();
    showToast("模型配置已保存到本机 secret store。");
  } catch (error) {
    showToast(error.message);
  }
});

$("#model-provider-select").addEventListener("change", () => {
  state.selectedModelProviderId = $("#model-provider-select").value;
  renderModelSettings();
});

$("#clear-model-key").addEventListener("click", async () => {
  try {
    const providerId = $("#model-provider-select").value;
    await request(`/settings/model-providers/${providerId}`, {
      method: "DELETE"
    });
    $("#model-api-key").value = "";
    await loadModelProviders();
    showToast("模型 API key 已清除。");
  } catch (error) {
    showToast(error.message);
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
    showToast("项目已创建，策划和美术 Agent 已开始开局讨论。");
  } catch (error) {
    showToast(error.message);
  }
});

$("#send-message").addEventListener("click", async () => {
  try {
    const content = $("#message-content").value.trim();
    if (!content) {
      showToast("先输入要发送给 Agent 群聊的内容。");
      return;
    }

    await sendProducerMessage({
      roomKind: state.activeRoomKind,
      messageType: $("#message-type").value,
      content
    });
    $("#message-content").value = "";
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      const preset = presets[button.dataset.preset];
      if (!preset) {
        return;
      }
      state.activeRoomKind = preset.roomKind;
      await sendProducerMessage(preset);
    } catch (error) {
      showToast(error.message);
    }
  });
});

async function sendProducerMessage(input) {
  ensureProject();
  await request(`/projects/${state.projectId}/messages`, {
    method: "POST",
    body: JSON.stringify(input)
  });
  await refreshProject();
}

async function refreshProject() {
  ensureProject();
  const [project, rooms, messages, taskBoard, artifacts, workspace] = await Promise.all([
    request(`/projects/${state.projectId}`),
    request(`/projects/${state.projectId}/rooms`),
    request(`/projects/${state.projectId}/messages`),
    request(`/projects/${state.projectId}/task-board`),
    request(`/projects/${state.projectId}/artifacts`),
    request(`/projects/${state.projectId}/workspace-tree`)
  ]);

  state.project = project.project;
  state.rooms = rooms.rooms;
  state.messages = messages.messages;
  state.taskBoard = taskBoard.taskBoard;
  state.artifacts = artifacts.artifacts;
  state.workspace = workspace;
  render();
}

function render() {
  renderModelSettings();
  renderProjectHeader();
  renderRooms();
  renderMessages();
  renderTaskBoard();
  renderArtifacts();
  renderWorkspace();
}

async function loadModelProviders() {
  const settings = await request("/settings/model-providers");
  state.modelProviders = settings.providers;
  if (!state.modelProviders.some((provider) => provider.providerId === state.selectedModelProviderId)) {
    state.selectedModelProviderId = state.modelProviders[0]?.providerId ?? "openai";
  }
  renderModelSettings();
}

function renderModelSettings() {
  const select = $("#model-provider-select");
  if (!state.modelProviders.length) {
    select.innerHTML = "";
    $("#model-config-summary").textContent = "未加载";
    $("#model-provider-status").innerHTML = '<div class="empty-state compact">正在读取模型配置</div>';
    return;
  }

  select.innerHTML = state.modelProviders
    .map((provider) => `<option value="${escapeHtml(provider.providerId)}">${escapeHtml(provider.label)}</option>`)
    .join("");
  select.value = state.selectedModelProviderId;

  const selected = state.modelProviders.find((provider) => provider.providerId === state.selectedModelProviderId) ?? state.modelProviders[0];
  $("#model-base-url").value = selected.baseUrl ?? "";
  $("#model-name").value = selected.defaultModel ?? "";
  $("#model-config-summary").textContent = `${state.modelProviders.filter((provider) => provider.hasApiKey).length}/${state.modelProviders.length} 已配置`;
  $("#model-provider-status").innerHTML = state.modelProviders
    .map((provider) => {
      const status = provider.hasApiKey ? `已配置 · ${provider.keyFingerprint}` : "未配置";
      const active = provider.providerId === state.selectedModelProviderId ? " active" : "";
      return `<button class="provider-row${active}" data-provider-id="${escapeHtml(provider.providerId)}" type="button">
        <span><span class="status-dot ${provider.hasApiKey ? "ready" : ""}"></span>${escapeHtml(provider.label)}</span>
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
}

function renderProjectHeader() {
  $("#project-title").textContent = state.project?.name ?? "未创建";
  $("#project-stage").textContent = state.project ? stageLabels[state.project.currentStage] ?? state.project.currentStage : "等待 idea";
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
      return `<button class="room-button${active}" data-room-kind="${escapeHtml(room.kind)}" type="button"><span>${escapeHtml(roomLabels[room.kind] ?? room.name)}</span><span>${count}</span></button>`;
    })
    .join("");

  roomList.querySelectorAll("[data-room-kind]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeRoomKind = button.dataset.roomKind;
      renderRooms();
      renderMessages();
    });
  });
}

function renderMessages() {
  const activeRoom = state.rooms.find((room) => room.kind === state.activeRoomKind);
  const messages = activeRoom ? state.messages.filter((message) => message.roomId === activeRoom.roomId) : state.messages;
  const list = $("#message-list");
  if (!messages.length) {
    list.className = "message-list empty-state";
    list.textContent = "当前房间还没有消息。";
    return;
  }

  list.className = "message-list";
  list.innerHTML = messages
    .map((message) => {
      const senderClass = message.senderType === "producer" ? "producer" : "agent";
      const sender = message.senderType === "producer" ? "制作人" : message.senderId;
      return `<article class="message ${senderClass}">
        <div class="message-meta">
          <span>${escapeHtml(sender)} · ${escapeHtml(message.messageType)}</span>
          <span>${new Date(message.createdAt).toLocaleTimeString()}</span>
        </div>
        <div class="message-content">${escapeHtml(message.content)}</div>
      </article>`;
    })
    .join("");
  list.parentElement.scrollTop = list.parentElement.scrollHeight;
}

function renderTaskBoard() {
  const board = $("#task-board");
  if (!state.taskBoard) {
    $("#task-summary").textContent = "0";
    board.innerHTML = '<div class="empty-state">暂无任务</div>';
    return;
  }

  const buckets = state.taskBoard.buckets;
  $("#task-summary").textContent = `${state.taskBoard.total} tasks · done ${buckets.done}`;
  board.innerHTML = state.taskBoard.taskGroups
    .map((group) => `<section class="task-group">
      <div class="task-title">
        <span>${escapeHtml(group.title)}</span>
        <span class="status-${escapeHtml(group.status)}">${escapeHtml(group.status)}</span>
      </div>
      ${group.tasks
        .map((task) => `<div class="task-item">
          <strong>${escapeHtml(task.title)}</strong>
          <div>${escapeHtml(task.ownerAgentId)} · <span class="status-${escapeHtml(task.status)}">${escapeHtml(task.status)}</span> · ${task.progressPercent ?? 0}%</div>
          ${task.blockers.length ? `<div>Blockers: ${escapeHtml(task.blockers.join("; "))}</div>` : ""}
        </div>`)
        .join("")}
    </section>`)
    .join("");
}

function renderArtifacts() {
  $("#artifact-summary").textContent = String(state.artifacts.length);
  $("#artifact-list").innerHTML =
    state.artifacts
      .map((artifact) => `<div class="artifact-item">
        <strong>${escapeHtml(artifact.type)}</strong> · ${escapeHtml(artifact.ownerAgentId)} · <span class="status-${escapeHtml(artifact.status)}">${escapeHtml(artifact.status)}</span>
        <code>${escapeHtml(artifact.path)}</code>
      </div>`)
      .join("") || '<div class="empty-state">暂无产物</div>';
}

function renderWorkspace() {
  if (!state.workspace) {
    $("#workspace-root").textContent = "未生成";
    $("#workspace-tree").innerHTML = '<div class="empty-state">暂无工作空间</div>';
    return;
  }

  $("#workspace-root").textContent = state.workspace.projectRoot.split("/").slice(-2).join("/");
  const files = state.workspace.entries.filter((entry) => entry.type === "file").slice(0, 80);
  $("#workspace-tree").innerHTML =
    files
      .map((entry) => `<div class="tree-item">
        ${entry.sizeBytes ?? 0} bytes
        <code>${escapeHtml(entry.path)}</code>
      </div>`)
      .join("") || '<div class="empty-state">暂无工作空间文件</div>';
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
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload;
}

function ensureProject() {
  if (!state.projectId) {
    throw new Error("请先创建项目。");
  }
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 2400);
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
