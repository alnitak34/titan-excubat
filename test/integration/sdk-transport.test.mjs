import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerifiedGate } from '../../src/gate.mjs';
import { fixture, model, options } from './transport-fixture.mjs';

test('real Node SDK encrypts request, decrypts tool response and verifies original wire bytes', async t => {
  const { client, state } = fixture(t);
  const response = await client.chat.completions.create({ model, stream: false,
    messages: [{ role: 'user', content: 'PRIVATE-TRANSPORT-SENTINEL' }] });
  assert.equal(response.choices[0].message.content, 'Verified reply');
  assert.deepEqual(response.choices[0].message.tool_calls[0].function, { name: 'hello', arguments: '{}' });
  const verdict = await client.verifyResponse(response.id);
  assert.equal(verdict.signatureKind, 'provider_tee');
  assert.equal(verdict.id, response.id);
  assert.equal(state.requests.length, 1);
  assert.equal(state.signatures, 1);
  assert.ok(state.pins.length > 0);
  assert.ok(state.policies > 0);
});

for (const fault of ['', 'bad-signature', 'tampered-body', 'missing-signature', 'gateway-only', 'nonce', 'spki', 'deployment']) {
  test(`gate plus real SDK transport: ${fault || 'valid response releases one tool'}`, async t => {
    const { client, state } = fixture(t, fault);
    const gate = new VerifiedGate({ models: [model], createClient: () => client });
    t.after(() => gate.dispose());
    const chunks = [];
    const run = async () => { for await (const chunk of gate.stream(options())) chunks.push(chunk); };
    if (fault) {
      await assert.rejects(run(), { code: 'NEARAI_VERIFICATION' });
      assert.deepEqual(chunks, []);
      if (['nonce', 'spki', 'deployment'].includes(fault)) assert.equal(state.requests.length, 0);
      else { assert.equal(state.requests.length, 1); assert.equal(state.signatures, 1); }
    } else {
      await run();
      assert.equal(chunks.filter(c => c.type === 'tool-call-delta').length, 1);
      assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
    }
  });
}
