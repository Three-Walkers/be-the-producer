import { parsePlaytestContract, parseSceneBlueprint, type SceneBlueprint, type PlaytestContract } from "@game-pipeline/shared-schemas";

// Compile-time and test-time checked, neutral examples, never project outputs.
export const sceneBlueprintExample: SceneBlueprint = {
  schemaVersion: "1.0.0", kind: "scene_blueprint", blueprintId: "example.scene", revision: 1,
  gameContract: { contractId: "replace_me.contract", revision: 1 }, entrySceneId: "main", prefabs: [],
  scenes: [{ sceneId: "main", name: "Main", role: "gameplay", nodes: [{
    nodeId: "game_root", testId: "game.root", name: "GameRoot", kind: "container",
    transform: { position: [0, 0], rotation: 0, scale: [1, 1], size: [750, 1334] }, tags: ["root"],
    components: [{ componentId: "game_controller", type: "ProjectController", properties: {}, bindings: [], references: [] }]
  }] }]
};
export const playtestContractExample: PlaytestContract = {
  schemaVersion: "1.0.0", kind: "playtest_contract", playtestId: "example.playtest", revision: 1,
  gameContract: { contractId: "replace_me.contract", revision: 1 },
  environment: { target: "web", orientation: "portrait", viewport: { width: 750, height: 1334, deviceScaleFactor: 1 }, maxScenarioDurationMs: 300000 },
  scenarios: [{ scenarioId: "example.start", title: "Replace with real project scenario", required: true, priority: "critical",
    startState: "replace_initial", steps: [{ stepId: "example.action", required: true, timeoutMs: 10000,
      action: { type: "input", actionId: "replace_action", phase: "perform", value: 1 },
      assertions: [{ type: "state", stateId: "replace_active" }] }], expectedEndState: "replace_active",
    requiredArtifacts: ["screenshot", "runtime_trace", "console_log"] }], qualityGates: []
};

export function engineeringContractGuide(types: string[]): string[] {
  const guide: string[] = [];
  if (types.includes("scene_blueprint")) guide.push(
    "SceneBlueprint 精确格式（示例不是完整游戏，必须替换 contractId/revision 并扩充真实节点；禁止额外根字段）：",
    JSON.stringify(parseSceneBlueprint(sceneBlueprintExample)),
    "节点是扁平 nodes[] 数组，以 parentNodeId 引用父节点，不能嵌套 children。每个 nodeId/testId/componentId 是小写稳定标识符；type 为 Cocos 组件类名。transform.position/scale/size 是2元数字数组，rotation为数字。kind=container|sprite|label|button|camera|audio|custom。scenes.role=boot|gameplay|result|overlay。",
    '组件必须有 properties:{},bindings:[],references:[]。binding精确形状 {property:"propertyName",source:{type:"input_action|runtime_signal|game_state",ref:"actual_contract_id"}}；reference为 {property:"propertyName",kind:"node",sceneId:"main",nodeId:"target_node"}，组件引用增加 kind:"component",componentId。不要发明事件、asset、script等额外字段。',
    "game_state.ref 必须是已登记 stateId，不是布尔表达式、metric名或自创 *_active。数值用 runtime_signal 引用真实 signalId；复杂状态组合由控制器实现，不声明不存在的信号。不要捏造 assets/img/*.png 资源路径，只能使用已登记实际资产；未提供的面板/按钮外观可以由程序绘制和真实Label实现。",
    "当前 Bridge 只支持一个 entry scene 与 prefabs=[]；程序负责实现所有自定义类，不要声明尚未实现的冗余模块组件。业务配置写自定义组件 properties，不新增顶层 modules/performanceBudgets，也不要写任务输出列表以外的说明文件。transform.position 是 Cocos 父节点本地坐标（中心原点、Y向上），不是画布左上角坐标；750×1334 全屏的左上角像素点需换算 [x-375,667-y]。Sprite.properties.assetKey 使用 manifest 的真实资产 id，不传 spriteFrame 文件路径。bindings 只向自定义组件属性注入 source.ref 字符串，不会自动订阅状态、刷新 Label 或注册按钮事件；用 stateId/signalId/actionId 这类字符串属性接收，由程序控制器明确实现监听与UI更新，不要绑定 Label.string/Button.interactable。UI 点击事件也必须由程序真实接线，不能把 clickAction 属性当成自动事件。"
  );
  if (types.includes("playtest_contract")) guide.push(
    "PlaytestContract 精确格式（示例仅说明字段，必须替换全部示例状态/动作，并覆盖真实成功、失败、重试、暂停、经济与升级路径）：",
    JSON.stringify(parsePlaytestContract(playtestContractExample)),
    'action只能为 {type:"input",actionId,phase:"start|perform|end",value?:number|string}、{type:"wait",durationMs:正整数} 或 {type:"system",command:"start|restart|pause|resume"}。assertions可为 {type:"state",stateId}、{type:"signal",signalId,operator:"eq|not_eq|gt|gte|lt|lte|exists|not_exists",expected?:string|number|boolean}、{type:"node",testId,expectation:"visible|hidden|enabled|disabled"}。exists/not_exists不带expected。',
    'step可增加 repeat:{maxIterations:1到100,until:[上述assertion]}；timeoutMs最多60000，maxScenarioDurationMs最多300000。qualityGates条目 {gateId,signalId,aggregation:"last|min|max|average|sum",operator:"eq|not_eq|gt|gte|lt|lte",expected}。全部引用必须属于当前GameContract/SceneBlueprint。不得新增脚本或JavaScript表达式，不能使用隐藏作弊动作替代真实玩法。'
  );
  return guide;
}
