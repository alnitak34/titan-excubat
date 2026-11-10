import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { fixture, model, measurements } from './transport-fixture.mjs';

let activeFixture;
// Only routes construction to a real SDK subclass with in-memory network and
// synthetic quote-verifier seams. No replacement of create/verifyResponse,
// encryption, response cache or production deployment policy.
class RoutedClient {
  constructor(config) { return new activeFixture.FixtureClient(config); }
}
// Provenance lookup verdicts are simulated here; production helper wiring is
// exercised, while actual SDK proof validation needs its own fixtures/live run.
mock.module('@nearai/inference-sdk/node', { namedExports: { InferenceClient: RoutedClient,
  verifyDeploymentImageProvenance: async () => { activeFixture.state.gatewayProvenance = true; },
  verifyComposeManagerDeploymentImageProvenance: async () => {
    activeFixture.state.modelProvenance = true;
    if (activeFixture.state.rejectProvenance) throw new Error('proof rejected');
  },
} });
const plugin = await import('../../src/plugin.mjs');

function idle(ctx, agent) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Harness did not become idle')); }, 5000);
    const off = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { clearTimeout(timer); off(); resolve(); }
    });
  });
}
async function setup(t, fault) {
  activeFixture = fixture(t, fault, { origin: 'https://cloud-api.near.ai', combined: true });
  const { state } = activeFixture;
  state.rejectProvenance = fault === 'provenance';
  state.tools = 0; state.chunks = [];
  const ctx = new Context();
  t.after(async () => { state.release.resolve(); await ctx.fiber.dispose(); });
  for (const service of [LlmRuntime, SessionStore, SessionProjectionRegistry]) await ctx.plugin(service);
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Test only' });
  for (const service of [ToolRuntime, NativeToolExecutor, AgentRegistry]) await ctx.plugin(service);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(plugin, { apiKey: 'TEST_ONLY_NOT_A_CREDENTIAL', models: [{ id: model, ...measurements }] });
  if (fault === 'tool-denied' || fault === 'approval-unavailable') {
    ctx.on('tools/pre-execute', async () => ({
      kind: fault === 'tool-denied' ? 'deny' : 'ask', reason: 'Fixture policy requires permission',
    }));
  }
  ctx.tools.register(defineContentToolFixture({ name: 'hello', description: 'Harmless in-memory counter',
    parameters: ['invalid-tool-args', 'valid-tool-args'].includes(fault) ? { amount: { type: 'number', const: 1, required: true } } : {},
    async execute() { state.tools++; return [{ type: 'text', text: 'hello done' }]; } }));
  const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'nearai', model });
  ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject === agent && frame.type === 'chunk') state.chunks.push(frame.chunk);
  });
  const done = idle(ctx, agent);
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'PRIVATE-TRANSPORT-SENTINEL' }], source: { kind: 'user' } }));
  return { state, agent, done };
}

test('combined real Harness/plugin/SDK waits for signature, executes one tool, encrypts next turn', async t => {
  const { state, done } = await setup(t, 'pending');
  await state.entered.promise;
  await tick();
  assert.equal(state.tools, 0);
  assert.equal(state.chunks.length, 0);
  state.release.resolve();
  await done;
  assert.equal(state.tools, 1, JSON.stringify(state.chunks));
  assert.equal(state.gatewayProvenance, true);
  assert.equal(state.modelProvenance, true);
  assert.equal(state.requests.length, 2);
  assert.ok(state.chunks.some(c => c.type === 'reasoning-delta' && c.text === 'PRIVATE-REASONING-SENTINEL'));
  const replay = state.requests[1].body.messages.find(m => m.role === 'assistant');
  assert.match(replay.reasoning_content, /^[a-f0-9]+$/i);
  assert.equal(state.requests[1].rawRequest.includes('PRIVATE-REASONING-SENTINEL'), false);
  assert.equal(state.signatures, 2);
  assert.equal(state.configs.length, 2);
  const toolResult = state.requests[1].body.messages.find(m => m.role === 'tool');
  assert.equal(toolResult.tool_call_id, 'call-transport');
  assert.match(toolResult.content, /^[a-f0-9]+$/i);
  assert.equal(state.requests[1].rawRequest.includes('hello done'), false);
  assert.equal(state.chunks.some(c => c.type === 'finish' && c.reason.kind === 'error'), false);
  for (const config of state.configs) {
    assert.equal(config.e2ee, true);
    assert.equal(config.gatewayVerification.includeSpkiFingerprint, true);
    assert.equal(config.baseUrl, 'https://cloud-api.near.ai/v1');
    assert.equal(typeof config.deploymentPolicy, 'function');
  }
});

// A cryptographically valid fixture must still obey the actual host executor.
// These checks cover typed tools and explicit policy, not arbitrary third-party tools.
test('typed tool positive control executes the permitted argument', async t => {
  const { state, done } = await setup(t, 'valid-tool-args');
  await done;
  assert.equal(state.tools, 1);
  assert.equal(state.signatures, 2);
});
test('unsupported numeric maximum is rejected when registering the typed tool', () => {
  assert.throws(() => defineContentToolFixture({ name: 'unsupported', description: 'Fixture',
    parameters: { amount: { type: 'number', maximum: 1 } }, async execute() { return []; },
  }), error => error.code === 'UNSUPPORTED_SCHEMA');
});
for (const fault of ['invalid-tool-args', 'tool-denied', 'approval-unavailable']) {
  test(`verified output does not bypass real Harness execution boundary: ${fault}`, async t => {
    const { state, done } = await setup(t, fault);
    await done;
    assert.equal(state.signatures, 2);
    assert.equal(state.requests.length, 2);
    assert.ok(state.chunks.some(c => c.type === 'tool-call-delta'));
    assert.equal(state.tools, 0);
    assert.ok(state.requests[1].body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'call-transport'));
  });
}

for (const fault of ['bad-signature', 'tampered-body', 'missing-signature', 'gateway-only', 'nonce', 'spki', 'os-policy', 'compose-policy', 'provenance', 'oversized-body']) {
  test(`combined real Harness/plugin/SDK executes zero tools: ${fault}`, async t => {
    const { state, done } = await setup(t, fault);
    await done;
    assert.equal(state.tools, 0);
    assert.equal(state.chunks.filter(c => c.type !== 'finish').length, 0);
    assert.ok(state.chunks.some(c => c.type === 'finish' && c.reason.kind === 'error'));
    if (['nonce', 'spki', 'os-policy', 'compose-policy', 'provenance'].includes(fault)) {
      assert.equal(state.requests.length, 0); assert.equal(state.signatures, 0);
    } else if (fault === 'oversized-body') {
      assert.equal(state.requests.length, 1); assert.equal(state.signatures, 0);
      assert.equal(state.bodyCancelled, true);
    } else { assert.equal(state.requests.length, 1); assert.equal(state.signatures, 1); }
  });
}

test('combined real Harness/plugin/SDK cancellation suppresses late valid signature', async t => {
  const { state, agent, done } = await setup(t, 'pending');
  await state.entered.promise;
  agent.cancel({ kind: 'user' });
  await done;
  state.release.resolve();
  // Wait for the gate to clean its actual SDK cache after verification settles.
  await state.cleared.promise;
  await tick();
  assert.equal(state.tools, 0);
  assert.equal(state.requests.length, 1);
  assert.equal(state.signatures, 1);
  assert.equal(state.chunks.filter(c => c.type !== 'finish').length, 0);
});
