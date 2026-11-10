import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeDiagnostic } from '../scripts/safe-diagnostic.mjs';

test('uncoded TypeError preserves useful category and suppresses private message', () => {
  const e = new TypeError("Cannot read properties of undefined (reading 'SECRET_KEY')");
  const result = safeDiagnostic(e);
  assert.equal(result.chain[0].kind, 'TypeError');
  assert.equal(result.chain[0].category, 'MISSING_PROPERTY');
  assert.ok(!JSON.stringify(result).includes('SECRET_KEY'));
});
test('arbitrary names, codes, stacks, headers and payloads never escape', () => {
  const e = Object.assign(new Error('PRIVATE_PROMPT'), {name:'PRIVATE_NAME',code:'PRIVATE_TOKEN',
    stack:'PRIVATE_STACK',headers:{authorization:'PRIVATE_HEADER'}, status: 999999});
  const text = JSON.stringify(safeDiagnostic(e));
  assert.ok(!text.includes('PRIVATE')); assert.ok(!text.includes('999999'));
});
test('nested network cause and HTTP status survive as bounded labels', () => {
  const e = Object.assign(new Error('fetch failed'), {status:503, cause:Object.assign(new Error('secret'),{code:'ECONNRESET'})});
  const result = safeDiagnostic(e);
  assert.equal(result.chain[0].httpStatus,503);
  assert.equal(result.chain[1].code,'ECONNRESET');
});
test('cycles and long cause chains are bounded', () => {
  const e = new Error('secret'); e.cause=e;
  assert.equal(safeDiagnostic(e).chain.length,1);
  let long = new Error(); for(let i=0;i<10;i++) long = new Error('secret',{cause:long});
  assert.equal(safeDiagnostic(long).chain.length,4);
});
test('accessor properties are never invoked', () => {
  let calls=0; const e={};
  for(const key of ['name','message','code','status','cause']) Object.defineProperty(e,key,{get(){calls++;throw Error('secret');}});
  safeDiagnostic(e); assert.equal(calls,0);
});
test('non-error thrown values still yield explicit classification', () => {
  for(const e of [undefined,null,'PRIVATE',42]) assert.ok(safeDiagnostic(e).chain.length>0);
});
test('SDK failure envelope preserves code and HTTP status without private details', () => {
  const e = Object.assign(new Error('PRIVATE'), {name:'VerificationError', failure:{
    code:'provenance.compose_file_request_failed', retryable:false,
    details:{status:403, file:'PRIVATE_FILE',token:'PRIVATE_TOKEN'}}});
  const result = safeDiagnostic(e);
  assert.equal(result.chain[0].code,'provenance.compose_file_request_failed');
  assert.equal(result.chain[0].httpStatus,403);
  assert.equal(result.chain[0].retryable,false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('only fixed deployment-image reasons are emitted; arbitrary details stay private', () => {
  const error = new Error('PRIVATE-MESSAGE');
  error.failure = { code: 'provenance.deployment_images_invalid', details: { reason: 'invalid_docker_compose', imageRepository: 'PRIVATE-IMAGE' } };
  assert.equal(safeDiagnostic(error).chain[0].reason, 'invalid_docker_compose');
  assert.equal(JSON.stringify(safeDiagnostic(error)).includes('PRIVATE'), false);
  error.failure.details.reason = 'PRIVATE-REASON';
  assert.equal(safeDiagnostic(error).chain[0].reason, undefined);
});
