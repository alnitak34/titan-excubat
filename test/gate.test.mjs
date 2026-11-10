import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { VerifiedGate } from '../src/gate.mjs';
import { deploymentPolicy } from '../src/policy.mjs';
import { toRequest } from '../src/protocol.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const options = () => ({ provider: 'nearai', model: 'test-model', messages: [{role:'user',content:[{type:'text',text:'Say hello'}]}], tools:[{name:'hello',description:'Harmless counter',parameters:{type:'object',properties:{}}}] });
const completion = () => ({ id:'reply-1', choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:'Ready',tool_calls:[{id:'call-1',type:'function',function:{name:'hello',arguments:'{}'}}]}}], usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13,prompt_tokens_details:{cached_tokens:2}} });
const verified = () => ({id:'reply-1',signatureKind:'provider_tee'});
function setup({create, verify, ...limits} = {}) {
  const state = { requests:[], verifies:0, clears:0, clients:0 };
  const gate = new VerifiedGate({models:['test-model'],...limits, createClient: headers => {
    state.clients++;
    return { chat:{completions:{create:async(body,opts) => {
      state.requests.push({body,opts,headers}); return create ? create(body,opts) : completion();
    }}}, verifyResponse:async id => { state.verifies++; return verify ? verify(id) : verified(); }, clearResponseCache:() => {state.clears++;} };
  }});
  return { gate, state };
}
// Deliberately an eager test sink, NOT the actual Harness agent-loop.
async function collect(stream, sink = {chunks:[], tools:0}) {
  for await (const chunk of stream) {
    sink.chunks.push(chunk);
    if (chunk.type === 'tool-call-delta') sink.tools++;
  }
  return sink;
}
test('no text or tool chunk escapes while verification is pending; positive control releases once', async () => {
  const pending = deferred(), {gate,state} = setup({verify:() => pending.promise});
  const sink = {chunks:[],tools:0}, done = collect(gate.stream(options()),sink);
  await tick(); assert.equal(state.verifies,1); assert.deepEqual(sink,{chunks:[],tools:0});
  pending.resolve(verified()); await done;
  assert.equal(sink.tools,1); assert.equal(sink.chunks.at(-1).reason.kind,'tool-calls');
  assert.equal(sink.chunks.at(-2).type,'usage');
  assert.equal(sink.chunks.at(-2).usage.inputTokens,8); assert.equal(state.clears,1);
});
for (const [name,verify] of [
  ['gateway-only',()=>({id:'reply-1',signatureKind:'gateway'})],
  ['missing verdict',()=>undefined],
  ['wrong response ID',()=>({id:'different',signatureKind:'provider_tee'})],
  ['verification rejection',()=>{throw new Error('secret prompt and credential');}],
]) test(name+' emits zero chunks and sanitizes diagnostics',async()=>{
  const {gate,state}=setup({verify}), sink={chunks:[],tools:0};
  await assert.rejects(collect(gate.stream(options()),sink), {message:'NEARAI_VERIFICATION'});
  assert.deepEqual(sink,{chunks:[],tools:0}); assert.equal(state.requests.length,1); assert.equal(state.verifies,1);
});
test('SDK preflight rejection produces no output and no response verification',async()=>{
  const {gate,state}=setup({create:()=>{throw new Error('attestation rejected');}}), sink={chunks:[],tools:0};
  await assert.rejects(collect(gate.stream(options()),sink));
  assert.equal(sink.tools,0);assert.equal(state.verifies,0);assert.equal(state.requests.length,1);
});
for (const stage of ['create','verify']) test('cancel during '+stage+' suppresses late success and reserves capacity until settled',async()=>{
  const pending=deferred(), ctrl=new AbortController();
  const {gate,state}=setup({[stage]:()=>pending.promise});
  const sink={chunks:[],tools:0};
  const done=collect(gate.stream({...options(),signal:ctrl.signal}),sink);
  await tick(); ctrl.abort(); await assert.rejects(done,{code:'ABORTED'});
  assert.equal(state.requests[0].opts.signal.aborted,true);
  await assert.rejects(collect(gate.stream(options())),{code:'NEARAI_BUSY'});
  pending.resolve(stage==='create'?completion():verified()); await tick();
  assert.deepEqual(sink,{chunks:[],tools:0}); assert.equal(state.clears,1);
});
test('already cancelled request never constructs client',async()=>{
  const {gate,state}=setup(); await assert.rejects(collect(gate.stream({...options(),signal:AbortSignal.abort()})),{code:'ABORTED'});
  assert.equal(state.clients,0);
});
test('dispose prevents late verification and all future requests',async()=>{
  const pending=deferred(),{gate}=setup({verify:()=>pending.promise}),sink={chunks:[],tools:0};
  const done=collect(gate.stream(options()),sink); await tick(); gate.dispose();
  await assert.rejects(done,{code:'NEARAI_DISPOSED'});pending.resolve(verified()); await tick();
  assert.equal(sink.chunks.length,0); await assert.rejects(collect(gate.stream(options())),{code:'NEARAI_DISPOSED'});
});
test('deadline prevents late verification',async()=>{
  const pending=deferred(),{gate}=setup({verify:()=>pending.promise,timeoutMs:10}),sink={chunks:[],tools:0};
  await assert.rejects(collect(gate.stream(options()),sink),{code:'NEARAI_DEADLINE'});
  pending.reject(new Error('late failure')); await tick(); assert.equal(sink.chunks.length,0);
});
test('cancel between verified chunks prevents subsequent tool release',async()=>{
  const {gate}=setup(),ctrl=new AbortController();const iter=gate.stream({...options(),signal:ctrl.signal});
  assert.equal((await iter.next()).value.type,'block-start');ctrl.abort();await assert.rejects(iter.next(),{code:'ABORTED'});
});
test('consumer closes iterator and cache is cleared',async()=>{
  const {gate,state}=setup();const iter=gate.stream(options());await iter.next();await iter.return();assert.equal(state.clears,1);
});
for (const [name,change] of [
  ['malformed later tool',r=>r.choices[0].message.tool_calls.push({id:'call-2',type:'function',function:{name:'hello',arguments:'broken'}})],
  ['undeclared tool',r=>r.choices[0].message.tool_calls[0].function.name='shell'],
  ['duplicate ID',r=>r.choices[0].message.tool_calls.push(structuredClone(r.choices[0].message.tool_calls[0]))],
  ['truncated output',r=>r.choices[0].finish_reason='length'],
  ['structured reasoning output',r=>r.choices[0].message.reasoning_content={text:'hidden'}],
  ['invalid usage',r=>r.usage.prompt_tokens=-1],
]) test(name+' rejects whole response before any chunks',async()=>{
  const response=completion();change(response);const {gate}=setup({create:()=>response}),sink={chunks:[],tools:0};
  await assert.rejects(collect(gate.stream(options()),sink));assert.equal(sink.chunks.length,0);
});
test('oversized response does not reach verification',async()=>{
  const {gate,state}=setup({maxResponseBytes:10});await assert.rejects(collect(gate.stream(options())),{code:'NEARAI_RESPONSE_LIMIT'});assert.equal(state.verifies,0);
});
test('oversized request and unsupported input do not contact SDK',async()=>{
  const {gate,state}=setup({maxRequestBytes:10});await assert.rejects(collect(gate.stream(options())),{code:'NEARAI_REQUEST_LIMIT'});assert.equal(state.clients,0);
  const other=setup();await assert.rejects(collect(other.gate.stream({...options(),reasoningEffort:'high'})),{code:'NEARAI_UNSUPPORTED'});assert.equal(other.state.clients,0);
});
test('headers and abort signal arrive at fake SDK create seam',async()=>{
  const {gate,state}=setup();await collect(gate.stream(options(),{'x-test':'harness'}));
  assert.equal(state.requests[0].opts.headers['x-test'],'harness');assert.equal(state.requests[0].headers['x-test'],'harness');
  assert.equal(state.requests[0].body.stream,false);
});
test('tool result ID and raw arguments preserved for second request',async()=>{
  const {gate,state}=setup();const first=await collect(gate.stream(options()));
  const blocks=first.chunks.filter(c=>c.type==='block-end').map(c=>c.block);
  const next=options();next.messages.push({role:'assistant',content:blocks}, {role:'tool',toolCallId:'call-1',source:{kind:'tool',callId:'call-1'},content:[{type:'text',text:'hello done'}]});
  await collect(gate.stream(next));const wire=state.requests[1].body.messages;
  assert.equal(wire[1].tool_calls[0].function.arguments,'{}');assert.equal(wire[2].tool_call_id,'call-1');assert.equal(wire[2].content,'hello done');
});
test('unmatched tool results and unrepresentable content order fail',()=>{
  const o=options();o.messages.push({role:'tool',toolCallId:'unknown',content:[]});assert.throws(()=>toRequest(o,2048));
  o.messages=[{role:'assistant',content:[{type:'tool-call',id:'a',name:'hello',arguments:'{}'},{type:'text',text:'after'}]}];assert.throws(()=>toRequest(o,2048));
});
test('deployment policy requires both approved measurements and exact model',()=>{
  const a='a'.repeat(64),b='b'.repeat(64), policy=deploymentPolicy([{id:'m',osImageHash:a,composeHash:b}]);
  policy({model:'m',deployment:{runtimeMeasurements:{osImageHash:a,composeHash:b}}});
  for (const p of [{model:'other',deployment:{runtimeMeasurements:{osImageHash:a,composeHash:b}}},{model:'m',deployment:{}},{model:'m',deployment:{runtimeMeasurements:{osImageHash:b,composeHash:b}}}])assert.throws(()=>policy(p),{code:'NEARAI_DEPLOYMENT'});
  assert.throws(()=>deploymentPolicy([]));
});
