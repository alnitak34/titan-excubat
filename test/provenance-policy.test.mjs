import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provenancePolicies } from '../src/provenance-policy.mjs';
import { VerifiedGate } from '../src/gate.mjs';
const measured={osImageHash:'a'.repeat(64),composeHash:'b'.repeat(64)};
const models=[{id:'test',...measured}];
test('every model approval awaits provenance for that exact authenticated deployment',async()=>{
  let release, calls=0;
  const waiting=new Promise(r=>release=r);
  const deployment={runtimeMeasurements:measured,composeManager:{actions:[]}};
  const p=provenancePolicies(models,{verifyGateway:async()=>{},verifyModel:async args=>{
    calls++;assert.equal(args.deployment,deployment);await waiting;
  }});
  let finished=false;
  const pending=p.model({model:'test',deployment}).then(()=>finished=true);
  await Promise.resolve();assert.equal(finished,false);release();await pending;
  await p.model({model:'test',deployment});assert.equal(calls,2);
});
test('same root measurements cannot bypass rejected changed manager provenance',async()=>{
  const p=provenancePolicies(models,{verifyGateway:async()=>{},verifyModel:async()=>{throw Error('denied');}});
  await assert.rejects(p.model({model:'test',deployment:{runtimeMeasurements:measured,composeManager:{actions:[{commit:'changed'}]}}}));
});
test('wrong measurements stop before any provenance lookup',async()=>{
  let calls=0;const p=provenancePolicies(models,{verifyGateway:async()=>{},verifyModel:async()=>calls++});
  await assert.rejects(p.model({model:'test',deployment:{runtimeMeasurements:{...measured,composeHash:'c'.repeat(64)}}}),{code:'NEARAI_DEPLOYMENT'});
  assert.equal(calls,0);
});
test('gateway provenance is required and failures propagate',async()=>{
  const p=provenancePolicies(models,{verifyGateway:async args=>{assert.equal(args.appCompose,'exact');throw Error('denied');},verifyModel:async()=>{}});
  await assert.rejects(p.gateway({appCompose:'exact'}));
});
test('model provenance requires the reviewed proxy revision as well as repository and workflow',async()=>{
  let observed;
  const p=provenancePolicies(models,{verifyGateway:async()=>{},verifyModel:async args=>{observed=args;}});
  await p.model({model:'test',deployment:{runtimeMeasurements:measured}});
  assert.deepEqual(observed.imagePolicies['nearaidev/vllm-proxy-rs'],{
    repository:'nearai/inference-proxy',workflow:'.github/workflows/build.yml',
    commit:'7924418b5eacb396a12ada208b0f2f0c82ec6d1d',
  });
  assert.equal(observed.composeManagerImagePolicy.repository,'nearai/compose-manager');
});
test('a proxy revision rejection stops the gate before response verification or output',async()=>{
  let signatureChecks=0, provenanceChecks=0, cleared=0;
  const p=provenancePolicies(models,{verifyGateway:async()=>{},verifyModel:async args=>{
    provenanceChecks++;
    const observedOldRevision='0'.repeat(40);
    if(args.imagePolicies['nearaidev/vllm-proxy-rs'].commit!==observedOldRevision)
      throw Error('commit_mismatch');
  }});
  const gate=new VerifiedGate({models:['test'],createClient:()=>({
    chat:{completions:{create:async()=>{
      await p.model({model:'test',deployment:{runtimeMeasurements:measured}});
      return {id:'must-not-pass'};
    }}},verifyResponse:async()=>{signatureChecks++;return {id:'must-not-pass',signatureKind:'provider_tee'};},
    clearResponseCache:()=>{cleared++;},
  })});
  const output=[];
  await assert.rejects(async()=>{
    for await(const chunk of gate.stream({provider:'nearai',model:'test',messages:[
      {role:'user',content:[{type:'text',text:'Synthetic test'}]},
    ]}))output.push(chunk);
  },{code:'NEARAI_VERIFICATION'});
  assert.equal(provenanceChecks,1);assert.equal(signatureChecks,0);
  assert.deepEqual(output,[]);assert.equal(cleared,1);gate.dispose();
});
