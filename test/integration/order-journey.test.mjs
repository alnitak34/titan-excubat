import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
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
import { fixture, model, measurements } from './order-transport-fixture.mjs';

let active;
class RoutedClient { constructor(config) { return new active.FixtureClient(config); } }
// Real SDK encryption/decryption/signatures; synthetic quote and provenance verdicts.
mock.module('@nearai/inference-sdk/node', { namedExports: {
  InferenceClient: RoutedClient,
  verifyDeploymentImageProvenance: async () => {},
  verifyComposeManagerDeploymentImageProvenance: async () => {},
} });
const plugin = await import('../../src/plugin.mjs');
const scenarios = [
  { name: 'verified-permitted', fault: 'pending', tools: 1, final: true },
  { name: 'tampered-response', fault: 'tampered-body', tools: 0, final: false },
  { name: 'gateway-only', fault: 'gateway-only', tools: 0, final: false },
  { name: 'permission-denied', fault: '', permission: 'deny', tools: 0, final: true },
  { name: 'approval-unavailable', fault: '', permission: 'ask', tools: 0, final: true },
  { name: 'cancelled-before-verdict', fault: 'pending', cancel: true, tools: 0, final: false },
  { name: 'final-response-rejected', fault: 'second-bad-signature', tools: 1, final: false },
];

test('reproducible order journey through real Harness, plugin and NEAR SDK', async t => {
  const rows=[];
  for(const scenario of scenarios) await t.test(scenario.name, async st => {
    active=fixture(st,scenario.fault,{origin:'https://cloud-api.near.ai',combined:true});
    const {state}=active;
    state.finalText=scenario.permission?'Order access was not granted.':'DEMO-1042: Ready for collection.';
    const ctx=new Context();
    let calls=0,tools=0,denied=0,turn=0,finalText='',toolResultReplayed=false;
    const chunks=[],events=[];
    let off,timer;
    st.after(async()=>{clearTimeout(timer);off?.();state.release.resolve();await ctx.fiber.dispose();});
    for(const service of [LlmRuntime,SessionStore,SessionProjectionRegistry])await ctx.plugin(service);
    await ctx.plugin(SystemPrompt,{personaPrefix:'Fictional order lookup demonstration.'});
    for(const service of [ToolRuntime,NativeToolExecutor,AgentRegistry])await ctx.plugin(service);
    await ctx.plugin(AgentLoop,{agents:[]});
    const value='DEMO-1042: Ready for collection.';
    class ObservedAdapter extends plugin.NearAiAdapter {
      async *stream(options){
        assert.ok(calls<2,'No more than two model turns allowed');
        turn=++calls;events.push({event:'model-turn',turn});
        if(turn===2)toolResultReplayed=options.messages.some(m=>m.role==='tool'&&m.content.some(b=>b.type==='text'&&b.text===value));
        yield* super.stream(options);
      }
    }
    const adapter=new ObservedAdapter({apiKey:'TEST_ONLY_NOT_A_CREDENTIAL',models:[{id:model,...measurements}]});
    st.after(()=>adapter.dispose());
    ctx.llm.registerAdapter(['nearai'],adapter);
    ctx.on('tools/pre-execute',async(exec,next)=>{
      if(scenario.permission||exec.name!=='lookup_order'||tools!==0){
        denied++;events.push({event:'permission-not-granted',kind:scenario.permission??'deny'});
        return {kind:scenario.permission??'deny',reason:'Fictional session permission boundary'};
      }
      return next();
    });
    ctx.tools.register(defineContentToolFixture({name:'lookup_order',description:'Read the single fictional order authorized for this session',parameters:{},
      async execute(){tools++;events.push({event:'order-read',order:'DEMO-1042'});return [{type:'text',text:value}];}}));
    const agent=await ctx.agentLoop.create(SessionId(randomUUID()),{provider:'nearai',model});
    ctx.on('agent/assistant-stream',({agent:subject,frame})=>{
      if(subject!==agent||frame.type!=='chunk')return;
      chunks.push({turn,...frame.chunk});
      if(turn===2&&frame.chunk.type==='text-delta')finalText+=frame.chunk.text;
    });
    const done=new Promise((resolve,reject)=>{
      off=ctx.on('agent/status',({agent:subject,status})=>{if(subject===agent&&status==='idle')resolve();});
      timer=setTimeout(()=>{agent.cancel({kind:'user'});reject(new Error('Journey did not finish'));},7000);
    });
    agent.followup(createUserMessage({content:[{type:'text',text:'Where is my order DEMO-1042? Use lookup_order once.'}],source:{kind:'user'}}));
    let beforeVerdict=null;
    if(scenario.fault==='pending'){
      await Promise.race([state.entered.promise,done.then(()=>{throw new Error('Ended before verification');})]);
      await tick();beforeVerdict={toolExecutions:tools,outputChunks:chunks.length};
      assert.deepEqual(beforeVerdict,{toolExecutions:0,outputChunks:0});
      if(scenario.cancel){agent.cancel({kind:'user'});await done;}
      state.release.resolve();
    }
    await done;
    if(scenario.cancel){await state.cleared.promise;await tick();}
    assert.equal(tools,scenario.tools);
    assert.equal(finalText,scenario.final?state.finalText:'');
    if(scenario.permission){assert.ok(denied>0);assert.equal(state.signatures,2);}
    if(scenario.name==='verified-permitted'){
      assert.equal(toolResultReplayed,true);assert.equal(calls,2);assert.equal(state.signatures,2);
      assert.equal(state.requests[1].rawRequest.includes(value),false,'Tool result must be encrypted on transport');
    }
    if(['tampered-response','gateway-only','cancelled-before-verdict'].includes(scenario.name))
      assert.equal(chunks.filter(c=>c.type!=='finish').length,0);
    if(scenario.name==='final-response-rejected'){
      assert.equal(toolResultReplayed,true);
      assert.equal(chunks.filter(c=>c.turn===2&&c.type!=='finish').length,0);
    }
    rows.push({scenario:scenario.name,toolExecutions:tools,modelTurns:calls,signatureChecks:state.signatures,
      beforeVerdict,toolResultReplayed,finalText,events,passed:true});
  });
  assert.equal(rows.length,7);
  const report={type:'CONTROLLED_REAL_HARNESS_SDK_JOURNEY',commit:process.env.GITHUB_SHA??null,
    scope:'Real Harness runtime, production plugin, NEAR SDK E2EE and Ed25519 checks. Ephemeral test keys, synthetic hardware/TLS/provenance verdicts and in-memory transport. No live NEAR inference or deployment approval.',
    tool:'Read-only fictional order in memory; no file, network, wallet or shell tool.',results:rows};
  await writeFile('order-journey-results.json',JSON.stringify(report,null,2)+'\n');
  console.log('EXCUBAT_JOURNEY_REPORT '+JSON.stringify(report));
});
