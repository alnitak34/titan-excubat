import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { signedFixture, checkFixture, toolResponse, finalResponse } from './signed-fixture.mjs';

const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
let run;
// ONLY the SDK client's transport/receipt seam is controlled. The production plugin,
// Harness services, tool executor and SDK signature verifier are actual package code.
class ControlledClient {
  createPinnedTlsFetch() { throw new Error('Not used by controlled client seam'); }
  constructor(options) {
    const state=run;
    state.configs.push(options);
    this.chat={completions:{create:async(body,requestOptions)=>{
      const index=state.requests.length;
      state.requests.push({body,requestOptions});
      if(state.mode==='attestation-rejection') throw new Error('FIXTURE_ATTESTATION_REJECTED');
      this.response=index===0?toolResponse():finalResponse();
      this.fixture=signedFixture(body,this.response);
      if(state.mode==='tampered-bytes') this.fixture.responseBody=Buffer.from('{}');
      if(state.mode==='bad-signature') this.fixture.signature.signature='00'.repeat(64);
      if(state.mode==='missing-signature') this.fixture.signature.signature='';
      return structuredClone(this.response);
    }}};
    this.verifyResponse=async id=>{
      state.verifications++;
      state.entered.resolve();
      if(state.mode==='pending')await state.release.promise;
      if(state.mode==='gateway-only')return {id,signatureKind:'gateway'};
      checkFixture(this.fixture);
      return {id,signatureKind:'provider_tee'};
    };
    this.clearResponseCache=()=>{state.clears++;};
  }
}
mock.module('@nearai/inference-sdk/node',{namedExports:{InferenceClient:ControlledClient,
  verifyDeploymentImageProvenance:async()=>{},verifyComposeManagerDeploymentImageProvenance:async()=>{}}});
const plugin=await import('../../src/plugin.mjs');

function idle(ctx,agent) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{off();reject(new Error('Harness did not become idle'));},5000);
    const off=ctx.on('agent/status',({agent:subject,status})=>{
      if(subject===agent&&status==='idle'){clearTimeout(timer);off();resolve();}
    });
  });
}
async function setup(t,mode) {
  const state=run={mode,requests:[],configs:[],verifications:0,clears:0,tools:0,chunks:[],entered:defer(),release:defer()};
  const ctx=new Context();
  t.after(async()=>{state.release.resolve();await ctx.fiber.dispose();});
  for(const service of [LlmRuntime,SessionStore,SessionProjectionRegistry])await ctx.plugin(service);
  await ctx.plugin(SystemPrompt,{personaPrefix:'Test only'});
  for(const service of [ToolRuntime,NativeToolExecutor,AgentRegistry])await ctx.plugin(service);
  await ctx.plugin(AgentLoop,{agents:[]});
  await ctx.plugin(plugin,{apiKey:'TEST_ONLY_NOT_A_CREDENTIAL',models:[{id:'fixture-model',osImageHash:'a'.repeat(64),composeHash:'b'.repeat(64)}]});
  ctx.tools.register(defineContentToolFixture({name:'hello',description:'Harmless in-memory counter',parameters:{},async execute(){state.tools++;return [{type:'text',text:'hello done'}];}}));
  const agent=await ctx.agentLoop.create(SessionId(randomUUID()),{provider:'nearai',model:'fixture-model'});
  ctx.on('agent/assistant-stream',({agent:subject,frame})=>{if(subject===agent&&frame.type==='chunk')state.chunks.push(frame.chunk);});
  const done=idle(ctx,agent);
  agent.followup(createUserMessage({content:[{type:'text',text:'Use hello once'}],source:{kind:'user'}}));
  return {ctx,agent,state,done};
}

test('real Harness loop holds all content pending verification, then executes one tool and continues',async t=>{
  const {state,done}=await setup(t,'pending');
  await state.entered.promise;await tick();
  assert.equal(state.tools,0);assert.equal(state.chunks.length,0);
  state.release.resolve();await done;
  assert.equal(state.tools,1);assert.equal(state.requests.length,2);assert.equal(state.verifications,2);
  const second=state.requests[1].body.messages.find(m=>m.role==='tool');
  assert.equal(second.tool_call_id,'call-1');assert.equal(second.content,'hello done');
  for(const config of state.configs){assert.equal(config.e2ee,true);assert.equal(config.gatewayVerification.includeSpkiFingerprint,true);assert.equal(typeof config.deploymentPolicy,'function');}
  assert.ok(Object.keys(state.requests[0].requestOptions.headers).length>0);
});
for(const mode of ['tampered-bytes','bad-signature','missing-signature','gateway-only','attestation-rejection']) {
  test(`real Harness executes zero tools for ${mode}`,async t=>{
    const {state,done}=await setup(t,mode);await done;
    assert.equal(state.tools,0);assert.equal(state.requests.length,1);
    assert.equal(state.chunks.filter(c=>c.type!=='finish').length,0);
    assert.ok(state.chunks.some(c=>c.type==='finish'&&c.reason.kind==='error'));
  });
}

test('real Harness cancellation suppresses late verified tool output',async t=>{
  const {state,agent,done}=await setup(t,'pending');
  await state.entered.promise;
  agent.cancel({kind:'user'});
  await done;
  state.release.resolve();await tick();
  assert.equal(state.tools,0);assert.equal(state.requests.length,1);
  assert.equal(state.chunks.filter(c=>c.type!=='finish').length,0);
});
