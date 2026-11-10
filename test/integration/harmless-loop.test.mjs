import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model, measurements } from './transport-fixture.mjs';
let active;
class RoutedClient { constructor(config) { return new active.FixtureClient(config); } }
mock.module('@nearai/inference-sdk/node', { namedExports: { InferenceClient: RoutedClient,
  verifyDeploymentImageProvenance: async () => {}, verifyComposeManagerDeploymentImageProvenance: async () => {},
} });
const { runHarmlessLoop } = await import('../../scripts/harmless-loop.mjs');
const config = { model: { id: model, ...measurements }, apiKey: 'TEST_ONLY_NOT_A_CREDENTIAL', receipt: 'fixture-receipt', timeoutMs: 5000 };
test('bounded live-loop harness replays a receipt only after verified tool execution', async t => {
  active = fixture(t, '', { origin: 'https://cloud-api.near.ai', combined: true });
  active.state.finalText = config.receipt;
  const report = await runHarmlessLoop(config);
  assert.equal(report.status, 'VERIFIED_HARNESS_TOOL_LOOP_COMPLETE', JSON.stringify(report));
  assert.equal(report.adapterCalls, 2); assert.equal(report.executedTools, 1);
  assert.equal(active.state.signatures, 2);
  assert.equal(active.state.requests[1].rawRequest.includes(config.receipt), false);
});
test('bounded live-loop harness stops before executing a tool with an invalid signature', async t => {
  active = fixture(t, 'bad-signature', { origin: 'https://cloud-api.near.ai', combined: true });
  const report = await runHarmlessLoop(config);
  assert.equal(report.status, 'BLOCKED_OR_INCOMPLETE');
  assert.equal(report.adapterCalls, 1); assert.equal(report.executedTools, 0);
  assert.equal(report.turns[0].errorCode, 'NEARAI_VERIFICATION');
});
test('second-turn rejection preserves a safe adapter code without retrying or leaking content', async t => {
  active = fixture(t, 'second-bad-signature', { origin: 'https://cloud-api.near.ai', combined: true });
  active.state.finalText = config.receipt;
  const report = await runHarmlessLoop(config);
  assert.equal(report.status, 'BLOCKED_OR_INCOMPLETE');
  assert.equal(report.adapterCalls, 2); assert.equal(report.executedTools, 1);
  assert.equal(report.toolResultReplayed, true);
  assert.equal(report.turns[1].chunks, 0);
  assert.equal(report.turns[1].errorCode, 'NEARAI_VERIFICATION');
  assert.equal(report.turns[1].diagnostic.chain[0].code, 'signature.invalid');
  assert.equal(JSON.stringify(report).includes(config.apiKey), false);
  assert.equal(JSON.stringify(report).includes(config.receipt), false);
});
test('bounded live-loop harness cannot pay for a third request or execute a second tool', async t => {
  active = fixture(t, 'repeat-tool', { origin: 'https://cloud-api.near.ai', combined: true });
  const report = await runHarmlessLoop(config);
  assert.equal(report.status, 'BLOCKED_OR_INCOMPLETE');
  assert.equal(report.adapterCalls, 2); assert.equal(active.state.requests.length, 2);
  assert.equal(report.executedTools, 1); assert.ok(report.deniedTools > 0);
  assert.ok(report.deniedExtraCalls > 0);
});
