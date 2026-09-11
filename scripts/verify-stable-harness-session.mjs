import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "btp-stable-session-test-"));
process.env.GAME_PIPELINE_SECRET_ROOT = join(root, "secrets");
const fakeClaude = join(root, "fake-claude.mjs");
process.env.CLAUDE_CLI_PATH = fakeClaude;
writeFileSync(fakeClaude, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
for await (const chunk of process.stdin) {}
const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
const workspace = config.mcpServers.btp_workspace.env.BTP_PROJECT_ROOT;
const record = path.join(process.env.CLAUDE_CONFIG_DIR, 'stable-cwd-test.json');
const prior = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null;
if (args.includes('--resume') && prior?.cwd !== process.cwd()) {
  process.stderr.write('No conversation found with session ID: session-test'); process.exit(1);
}
if (workspace === process.cwd()) throw new Error('MCP workspace must be separate from session cwd');
fs.writeFileSync(record, JSON.stringify({cwd:process.cwd(), workspaces:[...(prior?.workspaces??[]),workspace]}));
process.stdout.write(JSON.stringify({type:'result', result:'session resumed safely',session_id:'11111111-1111-4111-8111-111111111111'})+'\\n');
`);
chmodSync(fakeClaude, 0o755);
const { ClaudeCliHarness } = await import("../apps/api/dist/claudeCliHarness.js");
const { createConversationHarnessAuthorization } = await import("../apps/api/dist/toolAuthorization.js");
const { createStudioKernel, defaultAgentContracts } = await import("../packages/agent-runtime/dist/index.js");
const kernel = createStudioKernel("stable_session", "Stable session", "producer_test", "test");
const agent = defaultAgentContracts.find((candidate) => candidate.agentId === "game_designer");
const stateRoot = join(root, "canonical");
const firstWorkspace = join(root, "staging-one");
const secondWorkspace = join(root, "staging-two");
for (const directory of [stateRoot, firstWorkspace, secondWorkspace]) mkdirSync(directory);
const input = {
  projectId: kernel.project.projectId, stateRoot, agent,
  provider: {providerId:"test",label:"Test",protocol:"anthropic",baseUrl:"https://example.invalid",defaultModel:"test",apiKey:"test-only"},
  model:"test",systemPrompt:"test",userPrompt:"test",toolMode:"conversation",requireToolProgress:false,
  authorization:createConversationHarnessAuthorization(kernel,agent),sessionKey:"stable-room-session",sessionScope:"room"
};
try {
  const first = await new ClaudeCliHarness().run({...input,projectRoot:firstWorkspace});
  // A fresh Harness instance represents an API process restart; cwd cannot depend on an in-memory cache.
  const second = await new ClaudeCliHarness().run({...input,projectRoot:secondWorkspace,sessionId:first.sessionId});
  assert.equal(second.resumed,true);
  const record = JSON.parse(readFileSync(join(stateRoot,".be-the-producer/harness/game_designer/stable-cwd-test.json"),"utf8"));
  assert.deepEqual(record.workspaces,[firstWorkspace,secondWorkspace]);
  assert.ok(record.cwd.startsWith(join(realpathSync(stateRoot),".be-the-producer/harness/game_designer/session-cwd")));
  console.log("Stable session regression passed: fresh staging + persistent CLI cwd across Harness instances.");
} finally { rmSync(root,{recursive:true,force:true}); }
