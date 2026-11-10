import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provenancePolicies } from '../src/provenance-policy.mjs';
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
