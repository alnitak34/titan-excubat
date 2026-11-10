import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { getDiagnostic } from '../src/error-diagnostic.mjs';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { NearAiAdapter } from '../src/plugin.mjs';

const safeCodes = new Set(['NEARAI_UNSUPPORTED', 'NEARAI_RESPONSE', 'NEARAI_INCOMPLETE',
  'NEARAI_CONFIG', 'NEARAI_MODEL', 'NEARAI_BUSY', 'NEARAI_DISPOSED', 'NEARAI_DEADLINE',
  'NEARAI_REQUEST_LIMIT', 'NEARAI_RESPONSE_LIMIT', 'NEARAI_VERIFICATION', 'ABORTED',
  'LIVE_CALL_LIMIT', 'LIVE_REPLAY_REQUIRED']);
function adapterCode(error) {
  if (!error || typeof error !== 'object') return 'UNCLASSIFIED_FAILURE';
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  return safeCodes.has(code) ? code : 'UNCLASSIFIED_FAILURE';
}

// The fixture receipt is injectable for offline tests only. Live entry uses randomness.
// Only one in-memory tool is registered; no file, shell, network or wallet tool.
export async function runHarmlessLoop({ model, apiKey, receipt = randomBytes(16).toString('hex'), timeoutMs = 260000 }) {
  const report = { status: 'NOT_STARTED', adapterCalls: 0, deniedExtraCalls: 0,
    executedTools: 0, deniedTools: 0, maxAdapterCalls: 2, maxOutputTokensPerCall: 512,
    retryCount: 0, toolResultReplayed: false, finalReceiptMatched: false, turns: [],
    receiptSha256: createHash('sha256').update(receipt).digest('hex') };
  let closed = false, verifiedToolId, timer, off, agent;
  class BoundedAdapter extends NearAiAdapter {
    async *stream(options) {
      if (closed || report.adapterCalls >= 2) {
        report.deniedExtraCalls++;
        throw new LlmError('Experiment call budget exhausted', 'LIVE_CALL_LIMIT');
      }
      const turn = { index: ++report.adapterCalls, chunks: 0, finish: null };
      report.turns.push(turn);
      if (turn.index === 2) {
        report.toolResultReplayed = options.messages.some(m => m.role === 'tool' &&
          m.toolCallId === verifiedToolId && m.content.some(b => b.type === 'text' && b.text === receipt));
        if (report.executedTools !== 1 || !report.toolResultReplayed) {
          throw new LlmError('Missing matching tool result', 'LIVE_REPLAY_REQUIRED');
        }
      }
      let finalText = '';
      // Production verification implementation is unchanged; wrapper only narrows limits.
      try { for await (const chunk of super.stream({ ...options, maxTokens: 512 })) {
        turn.chunks++;
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          if (turn.index === 1 && chunk.block.name === 'hello') verifiedToolId = chunk.block.id;
        }
        if (chunk.type === 'usage') turn.usage = chunk.usage;
        if (chunk.type === 'finish') turn.finish = chunk.reason.kind;
        if (turn.index === 2 && chunk.type === 'text-delta') finalText += chunk.text;
        yield chunk;
      } } catch (error) {
        turn.errorCode = adapterCode(error);
        turn.diagnostic = getDiagnostic(error);
        throw error;
      }
      if (turn.index === 2) report.finalReceiptMatched = finalText.trim() === receipt;
    }
  }
  const ctx = new Context();
  const adapter = new BoundedAdapter({ apiKey, models: [model] });
  try {
    for (const service of [LlmRuntime, SessionStore, SessionProjectionRegistry]) await ctx.plugin(service);
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Bounded verification experiment. Use the hello tool once, then return its result verbatim.' });
    for (const service of [ToolRuntime, NativeToolExecutor, AgentRegistry]) await ctx.plugin(service);
    await ctx.plugin(AgentLoop, { agents: [] });
    ctx.llm.registerAdapter(['nearai'], adapter);
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (closed || exec.name !== 'hello' || report.executedTools >= 1) {
        report.deniedTools++;
        return { kind: 'deny', reason: 'Only one harmless receipt tool execution is allowed' };
      }
      return next();
    });
    ctx.tools.register(defineTool({ name: 'hello',
      description: 'Return a fresh random receipt. Call exactly once with no arguments, then output the receipt verbatim.',
      parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        if (closed || report.executedTools !== 0 || exec.callId !== verifiedToolId || report.turns[0]?.finish !== 'tool-calls') {
          throw new Error('Tool invocation did not follow the verified turn');
        }
        report.executedTools++;
        return receipt;
      },
    }));
    agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'nearai', model: model.id });
    const done = new Promise((resolve, reject) => {
      off = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') resolve();
      });
      timer = setTimeout(() => {
        closed = true; agent.cancel({ kind: 'user' }); adapter.dispose();
        reject(new Error('Bounded loop deadline'));
      }, timeoutMs);
    });
    report.status = 'RUNNING';
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: 'Call hello exactly once with {}. It returns a random receipt unavailable in this prompt. After receiving its result, reply with only that exact receipt. Do not call any tool again.' }] }));
    await done;
    report.status = report.adapterCalls === 2 && report.executedTools === 1 && report.toolResultReplayed &&
      report.finalReceiptMatched && report.turns[0]?.finish === 'tool-calls' && report.turns[1]?.finish === 'stop' &&
      report.deniedExtraCalls === 0 && report.deniedTools === 0 ? 'VERIFIED_HARNESS_TOOL_LOOP_COMPLETE' : 'BLOCKED_OR_INCOMPLETE';
  } catch { report.status = 'BLOCKED_OR_INCOMPLETE'; }
  finally {
    closed = true; clearTimeout(timer); off?.(); adapter.dispose();
    await ctx.fiber.dispose();
  }
  return report;
}
