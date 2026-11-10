import { GateError, requireValue } from './protocol.mjs';

// Limit bytes delivered by the SDK's pinned transport before its body readers
// buffer/parse them. The SDK may decompress first; this counts decoded bytes.
// This is not an OS memory ceiling or a bound on separate attestation/provenance I/O.
export function boundedResponse(response, maxBytes) {
  requireValue(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'NEARAI_CONFIG');
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        if (!(value instanceof Uint8Array) || value.byteLength > maxBytes - bytes) {
          const error = new GateError('NEARAI_RESPONSE_LIMIT');
          controller.error(error);
          void reader.cancel(error).catch(() => {});
          return;
        }
        bytes += value.byteLength;
        controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function boundPinnedTransport(client, maxBytes = 4 * 1024 * 1024) {
  // Version-pinned SDK seam. Fail closed if a future SDK removes it.
  requireValue(typeof client.createPinnedTlsFetch === 'function', 'NEARAI_CONFIG');
  const original = client.createPinnedTlsFetch.bind(client);
  client.createPinnedTlsFetch = fingerprint => {
    const pinnedFetch = original(fingerprint);
    return async (input, init) => boundedResponse(await pinnedFetch(input, init), maxBytes);
  };
  return client;
}
