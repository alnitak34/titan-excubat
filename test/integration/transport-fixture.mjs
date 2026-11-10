
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { AttestationClient, InferenceClient, prepareE2eeChatRequest } from '@nearai/inference-sdk/node';


// Protocol fixture follows the pinned NEAR SDK's inference-client.spec.ts.
// Real SDK encryption, decryption, nonce/binding checks and response verification.
// Synthetic quote verdict and in-memory TLS/network: NO hardware/TLS validation.
export const model = 'transport-fixture';
const fingerprint = '33'.repeat(32);
const compose = '{"services":{"model":"example@sha256:' + 'a'.repeat(64) + '"}}';
const hash = (value, algo = 'sha256') => createHash(algo).update(value).digest();
export const measurements = { osImageHash: 'a'.repeat(64), composeHash: hash(compose).toString('hex') };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const key = () => {
  const pair = generateKeyPairSync('ed25519');
  return { ...pair, hex: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
};
export const options = () => ({ provider: 'nearai', model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE-TRANSPORT-SENTINEL' }] }],
  tools: [{ name: 'hello', description: 'Private tool', parameters: { type: 'object', properties: {} } }] });

export function fixture(t, fault = '', { origin = 'https://gateway.test', combined = false } = {}) {
  const gatewayKey = key(), modelKey = key(), quotes = new Map();
  const state = { paths: [], requests: [], pins: [], configs: [], signatures: 0, policies: 0,
    entered: deferred(), release: deferred(), returned: deferred(), cleared: deferred() };
  const signatures = new Map();
  t.after(() => state.release.resolve());
  const attest = (nonce, signer, gateway) => {
    const boundNonce = fault === 'nonce' && !gateway ? '00'.repeat(32) : nonce;
    const signerBytes = Buffer.from(signer.hex, 'hex');
    const reportData = Buffer.concat([
      gateway ? hash(Buffer.concat([signerBytes, Buffer.from(fingerprint, 'hex')])) : signerBytes,
      Buffer.from(boundNonce, 'hex'),
    ]);
    const quoteId = `${signer.hex}:${nonce}`;
    // Synthetic authenticated runtime events, using the SDK's documented replay format.
    const eventLog = Object.entries({ 'os-image-hash': fault === 'os-policy' ? 'c'.repeat(64) : measurements.osImageHash,
      'compose-hash': fault === 'compose-policy' ? 'd'.repeat(64) : measurements.composeHash }).map(([event, payload]) => {
      const type = Buffer.alloc(4); type.writeUInt32LE(0x08000001);
      const digest = hash(Buffer.concat([type, Buffer.from(':' + event + ':'), Buffer.from(payload, 'hex')]), 'sha384');
      return { imr: 3, event_type: 0x08000001, event, event_payload: payload, digest: digest.toString('hex') };
    });
    const rtMr3 = eventLog.reduce((prior, event) => hash(Buffer.concat([prior, Buffer.from(event.digest, 'hex')]), 'sha384'), Buffer.alloc(48));
    quotes.set(quoteId, { tcbStatus: 'UpToDate', advisoryIds: [], debugEnabled: false,
      reportData, mrConfigId: Buffer.concat([Buffer.from([1]), hash(compose), Buffer.alloc(15)]),
      rtMr3 });
    return { request_nonce: nonce, signing_algo: 'ed25519', signing_address: signer.hex,
      ...(!gateway ? { signing_public_key: signer.hex } : { tls_cert_fingerprint: fingerprint }),
      intel_quote: quoteId, report_data: reportData.toString('hex'),
      event_log: eventLog,
      info: { tcb_info: { app_compose: compose } } };
  };
  const transport = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(url.origin, origin);
    state.paths.push(url.pathname);
    if (url.pathname.startsWith('/v1/model/'))
      return json({ metadata: { providerType: 'vllm', attestationSupported: true } });
    if (url.pathname === '/v1/attestation/report') {
      const nonce = url.searchParams.get('nonce');
      assert.match(nonce, /^[a-f0-9]{64}$/i);
      if (url.searchParams.has('model')) return json({ model_attestations: [attest(nonce, modelKey, false)] });
      assert.equal(url.searchParams.get('include_tls_fingerprint'), 'true');
      return json({ gateway_attestation: attest(nonce, gatewayKey, true) });
    }
    if (url.pathname.startsWith('/v1/signature/')) {
      state.signatures++;
      state.entered.resolve();
      if (fault === 'pending') await state.release.promise;
      state.returned.resolve();
      if (fault === 'missing-signature') return json({});
      const signature = signatures.get(url.pathname.slice('/v1/signature/'.length));
      assert.ok(signature);
      return json(signature);
    }
    assert.equal(url.pathname, '/v1/chat/completions', 'unexpected fixture route');
    const rawRequest = await request.text(), body = JSON.parse(rawRequest);
    state.requests.push({ rawRequest, body });
    if (fault === 'oversized-body') {
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)); },
        cancel() { state.bodyCancelled = true; },
      }), { headers: { 'content-type': 'application/json' } });
    }
    assert.equal(body.stream, false);
    assert.equal(rawRequest.includes('PRIVATE-TRANSPORT-SENTINEL'), false);
    assert.equal(request.headers.get('x-model-pub-key'), modelKey.hex);
    assert.equal(request.headers.get('x-encryption-version'), '2');
    assert.equal(request.headers.get('x-encrypt-all-fields'), 'true');
    assert.match(body.messages[0].content, /^[a-f0-9]+$/i);
    // Public preparation helper encrypts the fixture's assistant fields for the
    // fresh client key. It does not perform response-signature verification.
    const first = !combined || state.requests.length === 1 || fault === 'repeat-tool';
    const message = { role: 'assistant', content: !first && state.finalText ? state.finalText : 'Verified reply', reasoning_content: 'PRIVATE-REASONING-SENTINEL',
      ...(first ? { tool_calls: [{ id: fault === 'repeat-tool' ? `call-transport-${state.requests.length}` : 'call-transport', type: 'function', function: { name: 'hello',
        arguments: fault === 'invalid-tool-args' ? '{"amount":999}' : fault === 'valid-tool-args' ? '{"amount":1}' : '{}' } }] } : {}) };
    const prepared = await prepareE2eeChatRequest({
      request: new Request('https://gateway.test/v1/chat/completions', { method: 'POST',
        body: JSON.stringify({ model, messages: [message] }) }),
      modelKey: { signingAlgo: 'ed25519', publicKey: request.headers.get('x-client-pub-key') },
    });
    const encrypted = await prepared.request.json();
    const response = { id: `transport-reply-${state.requests.length}`, object: 'chat.completion', created: 0, model,
      choices: [{ index: 0, finish_reason: first ? 'tool_calls' : 'stop', message: encrypted.messages[0] }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } };
    const rawResponse = JSON.stringify(response);
    assert.equal(rawResponse.includes('Verified reply'), false);
    assert.equal(rawResponse.includes('PRIVATE-REASONING-SENTINEL'), false);
    assert.equal(rawRequest.includes('PRIVATE-REASONING-SENTINEL'), false);
    const gatewayOnly = fault === 'gateway-only', signer = gatewayOnly ? gatewayKey : modelKey;
    const signedText = `${gatewayOnly ? '' : model + ':'}${hash(rawRequest).toString('hex')}:${hash(rawResponse).toString('hex')}`;
    const signature = { text: signedText, signature: sign(null, Buffer.from(signedText), signer.privateKey).toString('hex'),
      signing_address: signer.hex, signing_algo: 'ed25519', signature_kind: gatewayOnly ? 'gateway' : 'provider_tee' };
    if (fault === 'bad-signature' || (fault === 'second-bad-signature' && state.requests.length === 2)) signature.signature = '00'.repeat(64);
    signatures.set(response.id, signature);
    // Change otherwise harmless signed bytes after signing. Decryption still works.
    if (fault === 'tampered-body') response.created = 1;
    return json(response);
  };
  t.mock.method(globalThis, 'fetch', transport);
  t.mock.method(AttestationClient.prototype, 'requestGatewayAttestation', async (request, capture) => {
    assert.equal(capture, true);
    return { response: await transport(request), peerSpkiFingerprint: fault === 'spki' ? '44'.repeat(32) : fingerprint };
  });
  const quoteVerifier = quote => { assert.ok(quotes.has(quote)); return quotes.get(quote); };
  class FixtureClient extends InferenceClient {
    constructor(config) {
      state.configs.push(config);
      super({ ...config,
        gatewayVerification: { ...config.gatewayVerification, verifiers: { ...config.gatewayVerification?.verifiers, tdxQuote: quoteVerifier } },
        modelVerification: { ...config.modelVerification, verifiers: { tdxQuote: quoteVerifier } },
      });
    }
    createPinnedTlsFetch(pin) { state.pins.push(pin); assert.equal(pin, fingerprint); return transport; }
    clearResponseCache() { const result = super.clearResponseCache(); state.cleared.resolve(); return result; }
  }
  const client = combined ? undefined : new FixtureClient({ baseUrl: origin + '/v1', e2ee: true, signingAlgo: 'ed25519',
    gatewayVerification: { includeSpkiFingerprint: true, verifiers: { tdxQuote: quoteVerifier } },
    modelVerification: { verifiers: { tdxQuote: quoteVerifier } },
    attestationCacheTimeToLiveMs: 0, responseCacheTimeToLiveMs: 120000,
    deploymentPolicy: () => { state.policies++; if (fault === 'deployment') throw new Error('fixture deployment denied'); },
  });
  t.after(() => client?.clearResponseCache());
  return { client, state, FixtureClient };
}

