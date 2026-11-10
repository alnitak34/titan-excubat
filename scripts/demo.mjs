// Offline presentation: recorded live evidence + actual gate with simulated SDK.
// No dependency installation, credentials, fetch, or live inference.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { VerifiedGate } from '../src/gate.mjs';

const evidence = JSON.parse(await readFile(new URL('../records/live-loop.json', import.meta.url)));
assert.equal(evidence.status, 'VERIFIED_HARNESS_TOOL_LOOP_COMPLETE');
assert.equal(evidence.adapterCalls, 2);
assert.equal(evidence.executedTools, 1);
assert.equal(evidence.finalReceiptMatched, true);
console.log('NEAR AI verified provider for DeepSeek Harness');
console.log('DEMO OFFLINE — evidencia registrada + escenarios simulados. No es inferencia en vivo.\n');
console.log('1. EVIDENCIA REAL REGISTRADA');
console.log('   Respuesta verificada → herramienta inocua → resultado → respuesta final verificada.');
console.log(`   ${evidence.adapterCalls} llamadas · ${evidence.executedTools} herramienta · ${evidence.retryCount} reintentos.`);
console.log(`   Commit probado: ${evidence.commit}`);
console.log(`   Fuente: ${evidence.source}`);
console.log('   El resumen local no es un recibo criptográfico autónomo; contrastar con el registro fuente.\n');

const options = {provider:'nearai',model:'demo-model', messages:[{role:'user',content:[{type:'text',text:'Use hello'}]}],
  tools:[{name:'hello',description:'Harmless demo tool',parameters:{type:'object',properties:{}}}]};
const response = {id:'demo-response',choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:'Hello',
  tool_calls:[{id:'demo-call',type:'function',function:{name:'hello',arguments:'{}'}}]}}],
  usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}};

console.log('2. COMPUERTA REAL DEL PLUGIN, SDK SIMULADO');
console.log('   Estos escenarios prueban bloqueo de salida; no verifican criptografía ni ejecutan herramientas.');
for (const scenario of ['provider_tee válido', 'solo gateway', 'verificación rechazada']) {
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const checking = new Promise(resolve => { entered = resolve; });
  const gate = new VerifiedGate({models:['demo-model'],createClient:()=>({
    chat:{completions:{create:async()=>structuredClone(response)}},
    verifyResponse:async()=>{
      entered(); await pending;
      if(scenario==='verificación rechazada') throw new Error('Simulated verification rejection');
      return {id:'demo-response',signatureKind:scenario==='solo gateway'?'gateway':'provider_tee'};
    }, clearResponseCache:()=>{}
  })});
  let chunks=0, toolChunks=0, errorCode;
  const finished=(async()=>{
    try { for await(const chunk of gate.stream(options)) {
      chunks++; if(chunk.type==='tool-call-delta') toolChunks++;
    }} catch(error) {errorCode=error.code;}
  })();
  await Promise.race([checking, finished.then(()=>{throw new Error('Scenario stopped before reaching verification');})]);
  assert.equal(chunks,0,'Output escaped before verification');
  release(); await finished; gate.dispose();
  if(scenario==='provider_tee válido') {
    assert.equal(errorCode,undefined); assert.equal(toolChunks,1);
  } else {
    assert.equal(errorCode,'NEARAI_VERIFICATION'); assert.equal(chunks,0);
  }
  console.log(`   ${scenario}: antes del veredicto 0 chunks; después ${chunks} chunks, ${toolChunks} de herramienta${errorCode?' · BLOQUEADO':''}.`);
}
console.log('\n3. LÍMITES');
console.log('   Una prueba real positiva no demuestra fiabilidad general ni ausencia de vulnerabilidades.');
console.log('   Los fallos históricos siguen sin causa establecida. El proceso local ve texto plano.');
console.log('   La firma del proveedor no prueba por sí sola el modelo exacto ni que una acción sea segura.');
console.log('\nRESULTADO: evidencia cargada y escenarios locales comprobados. Cero llamadas externas de esta demo.');

