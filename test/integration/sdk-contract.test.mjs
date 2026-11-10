import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InferenceClient } from '@nearai/inference-sdk/node';
import { NearAiAdapter, Config, apply } from '../../src/plugin.mjs';
import { signedFixture, checkFixture, toolResponse } from './signed-fixture.mjs';

test('production plugin and real Node SDK load without contacting a service', async () => {
  const client = new InferenceClient({apiKey:'TEST_ONLY_NOT_A_CREDENTIAL',e2ee:true});
  assert.equal(typeof client.verifyResponse,'function');
  assert.equal(typeof client.chat.completions.create,'function');
  client.clearResponseCache();
  const config={apiKey:'TEST_ONLY_NOT_A_CREDENTIAL',models:[{id:'fixture-model',osImageHash:'a'.repeat(64),composeHash:'b'.repeat(64)}]};
  assert.equal(typeof Config,'function');
  const adapter = new NearAiAdapter(config);
  assert.equal((await adapter.listModels('nearai')).length,1);
  assert.equal(adapter.providerRetryPolicy().maxRetries,0);
  await assert.rejects(adapter.resolveModel('nearai','not-allowed'),{code:'NEARAI_MODEL'});
  const disposed=[]; let registered;
  apply({ on:(event,fn)=>{assert.equal(event,'dispose');disposed.push(fn);},llm:{registerAdapter:(routes,instance)=>{registered={routes,instance};}} },config);
  assert.deepEqual(registered.routes,['nearai']);disposed.forEach(fn=>fn());adapter.dispose();
});

test('real SDK accepts signed bytes and rejects mutations, wrong signer and gateway claim', () => {
  const body={model:'fixture-model',messages:[{role:'user',content:'hi'}]};
  const fixture=signedFixture(body,toolResponse());checkFixture(fixture);
  for (const mutate of [
    f=>{f.responseBody=Buffer.from(JSON.stringify({...toolResponse(),id:'tampered'}));},
    f=>{f.requestBody=Buffer.from(JSON.stringify({...body,model:'other-model'}));},
    f=>{f.signature.signature='00'.repeat(64);},
    f=>{f.signature.signature='';},
    f=>{f.signature.kind='gateway';},
    f=>{f.attestation.signer.signingAddress='00'.repeat(32);},
  ]) { const changed=structuredClone(fixture);mutate(changed);assert.throws(()=>checkFixture(changed)); }
});

test('test environment refuses network access', async () => {
  assert.throws(()=>fetch('https://cloud-api.near.ai/v1'),{message:'TEST_NETWORK_FORBIDDEN'});
});
