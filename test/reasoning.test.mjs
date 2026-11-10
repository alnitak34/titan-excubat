import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerifiedGate } from '../src/gate.mjs';
import { toChunks, toRequest } from '../src/protocol.mjs';
const request = { model:'test', tools:[] };
const response = () => ({ id:'r', choices:[{finish_reason:'stop',message:{role:'assistant',content:'HELLO',reasoning_content:'Private reasoning'}}],
  usage:{prompt_tokens:24,completion_tokens:39,total_tokens:63,prompt_tokens_details:null,
    reasoning_tokens:36,completion_tokens_details:{reasoning_tokens:36}} });
test('reasoning is a separate Harness block and survives next-turn serialization', () => {
  const chunks=toChunks(response(),request);
  assert.deepEqual(chunks.filter(c=>c.type==='block-end').map(c=>c.block.type),['reasoning','text']);
  const blocks=chunks.filter(c=>c.type==='block-end').map(c=>c.block);
  const next=toRequest({provider:'nearai',model:'test',messages:[{role:'assistant',content:blocks}]},512);
  assert.equal(next.messages[0].reasoning_content,'Private reasoning');
  assert.equal(next.messages[0].content,'HELLO');
  assert.equal(chunks.find(c=>c.type==='usage').usage.reasoningTokens,36);
});
test('ambiguous reasoning alias, malformed counters and unrepresentable order reject', () => {
  for (const mutate of [r=>r.choices[0].message.reasoning='alias',r=>r.usage.reasoning_tokens=37,
    r=>r.usage.completion_tokens_details.reasoning_tokens=100]) {
    const r=response();mutate(r); assert.throws(()=>toChunks(r,request));
  }
  assert.throws(()=>toRequest({provider:'nearai',model:'test',messages:[{role:'assistant',content:[
    {type:'text',text:'answer'},{type:'reasoning',text:'late'}]}]},512));
});
test('pending or rejected verification releases no reasoning or text', async () => {
  let reject, entered;
  const waiting=new Promise(resolve=>entered=resolve), verdict=new Promise((_,r)=>reject=r);
  const gate=new VerifiedGate({models:['test'],createClient:()=>({chat:{completions:{create:async()=>response()}},
    verifyResponse:()=>{entered();return verdict;},clearResponseCache(){}})});
  const chunks=[];
  const done=(async()=>{for await(const c of gate.stream({provider:'nearai',model:'test',messages:[]}))chunks.push(c);})();
  await waiting;assert.equal(chunks.length,0);
  reject(new Error('invalid signature'));await assert.rejects(done);assert.equal(chunks.length,0);
});
