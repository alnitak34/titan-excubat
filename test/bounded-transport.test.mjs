import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedResponse, boundPinnedTransport } from '../src/bounded-transport.mjs';

test('bounded transport preserves exact bytes at cap and original pin/options', async () => {
  const bytes = new Uint8Array([0, 255, 13, 10]);
  const init = { signal: new AbortController().signal };
  const client = boundPinnedTransport({ createPinnedTlsFetch(pin) {
    assert.equal(pin, 'original-pin');
    return async (url, options) => {
      assert.equal(url, 'https://fixture.test'); assert.equal(options, init);
      return new Response(bytes, { headers: { 'x-fixture': 'preserved' } });
    };
  } }, 4);
  const response = await client.createPinnedTlsFetch('original-pin')('https://fixture.test', init);
  assert.equal(response.headers.get('x-fixture'), 'preserved');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

for (const size of [2, 5]) {
  test(`oversized chunked response rejects and cancels source (chunk=${size})`, async () => {
    let cancelled = false, pulls = 0;
    const response = new Response(new ReadableStream({
      pull(c) { pulls++; c.enqueue(new Uint8Array(size)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    await assert.rejects(boundedResponse(response, 4).arrayBuffer(), { code: 'NEARAI_RESPONSE_LIMIT' });
    assert.equal(cancelled, true); assert.ok(pulls <= 3);
  });
}
test('consumer cancellation propagates without buffering remaining body', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await boundedResponse(response, 4).body.cancel();
  assert.equal(cancelled, true);
});
test('transport errors stay errors; missing SDK seam fails closed', async () => {
  const response = new Response(new ReadableStream({ start(c) { c.error(new Error('fixture failure')); } }));
  await assert.rejects(boundedResponse(response, 4).arrayBuffer(), /fixture failure/);
  assert.throws(() => boundPinnedTransport({}), { code: 'NEARAI_CONFIG' });
});
