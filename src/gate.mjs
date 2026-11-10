import { GateError, requireValue, toRequest, toChunks } from './protocol.mjs';
import { captureDiagnostic } from './error-diagnostic.mjs';

function abortError(signal) {
  return new GateError(signal.reason instanceof GateError ? signal.reason.code : 'ABORTED');
}
function waitFor(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const stop = () => reject(abortError(signal));
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** Internal test seam; production plugin always constructs the actual Node SDK. */
export class VerifiedGate {
  #createClient; #models; #active = new Set(); #disposed = false; #limits;
  constructor({ createClient, models, maxConcurrent = 1, timeoutMs = 120000,
    maxResponseBytes = 1048576, maxRequestBytes = 1048576, maxOutputTokens = 2048 }) {
    requireValue(typeof createClient === 'function' && Array.isArray(models) && models.length > 0, 'NEARAI_CONFIG');
    for (const n of [maxConcurrent, timeoutMs, maxResponseBytes, maxRequestBytes, maxOutputTokens])
      requireValue(Number.isSafeInteger(n) && n > 0 && n <= 2147483647, 'NEARAI_CONFIG');
    this.#createClient = createClient; this.#models = new Set(models);
    this.#limits = { maxConcurrent, timeoutMs, maxResponseBytes, maxRequestBytes, maxOutputTokens };
  }
  dispose() {
    this.#disposed = true;
    for (const c of this.#active) c.abort(new GateError('NEARAI_DISPOSED'));
  }
  async *stream(options, headers = {}) {
    requireValue(!this.#disposed, 'NEARAI_DISPOSED');
    requireValue(this.#models.has(options.model), 'NEARAI_MODEL');
    requireValue(this.#active.size < this.#limits.maxConcurrent, 'NEARAI_BUSY');
    const controller = new AbortController(), signal = controller.signal;
    const cancel = () => controller.abort(new GateError('ABORTED'));
    if (options.signal?.aborted) cancel();
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new GateError('NEARAI_DEADLINE')), this.#limits.timeoutMs);
    this.#active.add(controller);
    let client, operation, settled = false, chunks;
    const cleanup = () => { client?.clearResponseCache(); this.#active.delete(controller); };
    try {
      if (signal.aborted) throw abortError(signal);
      const request = structuredClone(toRequest(options, this.#limits.maxOutputTokens));
      requireValue(Buffer.byteLength(JSON.stringify(request)) <= this.#limits.maxRequestBytes, 'NEARAI_REQUEST_LIMIT');
      client = this.#createClient(headers);
      operation = (async () => {
        const response = await client.chat.completions.create(request, { signal, headers });
        if (signal.aborted) throw abortError(signal);
        requireValue(Buffer.byteLength(JSON.stringify(response)) <= this.#limits.maxResponseBytes, 'NEARAI_RESPONSE_LIMIT');
        requireValue(typeof response.id === 'string' && response.id.length > 0, 'NEARAI_RESPONSE');
        const result = await client.verifyResponse(response.id);
        if (signal.aborted) throw abortError(signal);
        requireValue(result?.signatureKind === 'provider_tee' && result.id === response.id, 'NEARAI_VERIFICATION');
        return toChunks(response, request);
      })();
      // Slot stays reserved if an SDK operation ignores cancellation. No unbounded orphan requests.
      operation.then(() => { settled = true; }, () => { settled = true; });
      chunks = await waitFor(operation, signal);
      for (const chunk of chunks) {
        if (signal.aborted) throw abortError(signal);
        yield chunk;
      }
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      throw error instanceof GateError ? error : captureDiagnostic(new GateError('NEARAI_VERIFICATION'), error);
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
      chunks = undefined;
      controller.abort(new GateError('ABORTED'));
      if (!operation || settled) cleanup();
      else operation.then(cleanup, cleanup);
    }
  }
}
