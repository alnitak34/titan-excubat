import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerifiedGate } from '../src/gate.mjs';
import { hasDuplicateKeys, toChunks } from '../src/protocol.mjs';

const request = { tools: [{ function: { name: 'hello' } }] };
const response = args => ({ id: 'r', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
  tool_calls: [{ id: 'c', type: 'function', function: { name: 'hello', arguments: args } }] } }] });

test('duplicate keys are detected at any depth', () => {
  for (const s of ['{"a":1,"a":2}', '{"x":{"b":1,"b":2}}', '{"l":[{"k":1,"k":2}]}', '{"a":1,"b":2,"a":3}', '{"a\\"":1,"a\\"":2}'])
    assert.equal(hasDuplicateKeys(s), true, s);
});
test('lookalikes that are not duplicates are accepted', () => {
  for (const s of ['{}', '{"a":1,"b":2}', '{"a":{"a":1}}', '{"a":[{"a":1},{"a":2}]}',
    '{"a":"a","b":"a"}', '{"a":"\\"a\\":1,\\"a\\":2"}', '{"a":1,"a\\u0000":2}', '{"a":[1,2,"a"],"b":1}'])
    assert.equal(hasDuplicateKeys(s), false, s);
});
test('escaped and literal spellings of one key count as duplicates', () => {
  assert.equal(hasDuplicateKeys('{"a":1,"\\u0061":2}'), true);
});
test('response with duplicate-key arguments is rejected as a whole', () => {
  assert.throws(() => toChunks(response('{"a":1,"a":2}'), request), { code: 'NEARAI_RESPONSE' });
  assert.ok(toChunks(response('{"a":1,"b":2}'), request).length > 0);
});

const base = () => ({ provider: 'nearai', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
test('malformed input reports NEARAI_UNSUPPORTED and never contacts the SDK', async () => {
  let clients = 0;
  const gate = new VerifiedGate({ models: ['m'], createClient: () => { clients++; return {}; } });
  for (const messages of [[{ role: 'user', content: [null] }], [null], [{ role: 'assistant', content: [undefined] }]]) {
    await assert.rejects((async () => { for await (const _ of gate.stream({ ...base(), messages })); })(), { code: 'NEARAI_UNSUPPORTED' });
  }
  assert.equal(clients, 0);
  gate.dispose();
});
