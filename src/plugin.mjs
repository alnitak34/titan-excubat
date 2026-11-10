import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { InferenceClient, verifyDeploymentImageProvenance,
  verifyComposeManagerDeploymentImageProvenance } from '@nearai/inference-sdk/node';
import { VerifiedGate } from './gate.mjs';
import { transferDiagnostic } from './error-diagnostic.mjs';
import { provenancePolicies } from './provenance-policy.mjs';
import { boundPinnedTransport } from './bounded-transport.mjs';
import { requireValue } from './protocol.mjs';

export const name = 'llm-nearai-verified';
export const inject = ['llm'];
export const Config = z.object({
  apiKey: z.string(),
  models: z.array(z.object({ id: z.string().required(), osImageHash: z.string().required(), composeHash: z.string().required() })).required(),
});

export class NearAiAdapter extends LlmAdapter {
  #gate; #models;
  constructor(config) {
    super();
    const models = structuredClone(config.models);
    const policies = provenancePolicies(models, {
      verifyGateway: verifyDeploymentImageProvenance,
      verifyModel: verifyComposeManagerDeploymentImageProvenance,
    });
    const apiKey = config.apiKey || process.env.NEARAI_API_KEY;
    requireValue(typeof apiKey === 'string' && apiKey.length > 0, 'NEARAI_CONFIG');
    this.#models = models.map(m => ({ provider: 'nearai', id: m.id, name: m.id,
      inputModalities: ['text'], defaultMaxTokens: 2048 }));
    this.#gate = new VerifiedGate({
      models: models.map(m => m.id),
      createClient: headers => boundPinnedTransport(new InferenceClient({
        apiKey, baseUrl: 'https://cloud-api.near.ai/v1', headers,
        e2ee: true, gatewayVerification: { includeSpkiFingerprint: true,
          verifiers: { deployment: policies.gateway } },
        attestationCacheTimeToLiveMs: 0, responseCacheTimeToLiveMs: 120000,
        deploymentPolicy: policies.model,
      })),
    });
  }
  providerInfo(provider) { return { id: provider, name: 'NEAR AI · verified responses' }; }
  providerRetryPolicy() {
    return { mode: 'normal', maxRetries: 0, retryableCodes: ['NEARAI_NO_RETRY'],
      initialDelayMs: 500, maxDelayMs: 500, jitterRatio: 0 };
  }
  async listModels(provider) { return provider === 'nearai' ? structuredClone(this.#models) : []; }
  async resolveModel(provider, model, signal) {
    signal?.throwIfAborted();
    const info = this.#models.find(m => m.id === model && m.provider === provider);
    if (!info) throw new LlmError('Model is not configured', 'NEARAI_MODEL');
    return structuredClone(info);
  }
  async *stream(options) {
    try { yield* this.#gate.stream(options, attributionHeaders()); }
    catch (error) {
      throw transferDiagnostic(new LlmError('NEAR AI response withheld', error.code ?? 'NEARAI_VERIFICATION'), error);
    }
  }
  dispose() { this.#gate.dispose(); }
}

export function apply(ctx, config) {
  const adapter = new NearAiAdapter(config);
  ctx.on('dispose', () => adapter.dispose());
  ctx.llm.registerAdapter(['nearai'], adapter);
}
