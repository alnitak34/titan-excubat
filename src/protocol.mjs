export class GateError extends Error {
  constructor(code) { super(code); this.name = 'GateError'; this.code = code; }
}
export function requireValue(condition, code = 'NEARAI_UNSUPPORTED') {
  if (!condition) throw new GateError(code);
}
const text = value => typeof value === 'string';
const nonempty = value => text(value) && value.length > 0;
function textContent(content) {
  requireValue(Array.isArray(content) && content.every(b => b.type === 'text' && text(b.text)));
  return content.map(b => b.text).join('');
}

// No provider replay, multimodal input, or reasoning is silently discarded.
export function toRequest(options, maxOutputTokens) {
  requireValue(options.provider === 'nearai' && nonempty(options.model));
  requireValue(options.reasoningEffort === undefined && options.toolChoice === undefined);
  requireValue(Array.isArray(options.messages));
  const messages = [];
  if (options.system !== undefined) {
    requireValue(text(options.system));
    messages.push({ role: 'system', content: options.system });
  }
  const outstanding = new Set();
  const usedCalls = new Set();
  for (const m of options.messages) {
    requireValue(m.source?.replayState === undefined);
    if (m.role === 'assistant') {
      requireValue(outstanding.size === 0 && Array.isArray(m.content));
      let seenTool = false;
      const parts = [], calls = [], reasoning = [];
      for (const b of m.content) {
        if (b.type === 'reasoning') {
          requireValue(!seenTool && parts.length === 0 && text(b.text));
          reasoning.push(b.text);
        } else if (b.type === 'text') {
          requireValue(!seenTool && text(b.text));
          parts.push(b.text);
        } else {
          requireValue(b.type === 'tool-call' && nonempty(b.id) && nonempty(b.name) && text(b.arguments));
          requireValue(!usedCalls.has(b.id));
          usedCalls.add(b.id); outstanding.add(b.id); seenTool = true;
          calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } });
        }
      }
      messages.push({ role: 'assistant', content: parts.join('') || null,
        ...(reasoning.length ? { reasoning_content: reasoning.join('') } : {}),
        ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === 'tool') {
      requireValue(nonempty(m.toolCallId) && outstanding.delete(m.toolCallId));
      requireValue(m.source?.callId === undefined || m.source.callId === m.toolCallId);
      messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: textContent(m.content) });
    } else {
      requireValue(['system', 'user', 'developer'].includes(m.role) && outstanding.size === 0);
      requireValue(m.role !== 'system' || messages.length === 0);
      messages.push({ role: m.role, content: textContent(m.content) });
    }
  }
  requireValue(outstanding.size === 0);
  const cap = options.maxTokens ?? maxOutputTokens;
  requireValue(Number.isSafeInteger(cap) && cap > 0 && cap <= maxOutputTokens);
  const body = { model: options.model, messages, stream: false, max_tokens: cap };
  if (options.temperature !== undefined) {
    requireValue(Number.isFinite(options.temperature) && options.temperature >= 0 && options.temperature <= 2);
    body.temperature = options.temperature;
  }
  if (options.stop !== undefined) {
    requireValue(Array.isArray(options.stop) && options.stop.every(nonempty));
    body.stop = [...options.stop];
  }
  if (options.tools !== undefined) {
    requireValue(Array.isArray(options.tools));
    const names = new Set();
    body.tools = options.tools.map(t => {
      requireValue(!t.deferLoading && nonempty(t.name) && text(t.description) && t.parameters && typeof t.parameters === 'object' && !Array.isArray(t.parameters));
      requireValue(!names.has(t.name)); names.add(t.name);
      return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
    });
    if (!body.tools.length) delete body.tools;
  }
  return body;
}

// Validate the COMPLETE response before creating any externally visible chunks.
export function toChunks(response, request) {
  requireValue(Array.isArray(response.choices) && response.choices.length === 1, 'NEARAI_RESPONSE');
  const choice = response.choices[0], m = choice.message;
  requireValue(m?.role === 'assistant' && (m.content === null || text(m.content)), 'NEARAI_RESPONSE');
  requireValue(!m.refusal && !m.audio && !m.reasoning && !m.function_call, 'NEARAI_UNSUPPORTED');
  requireValue(m.reasoning_content == null || text(m.reasoning_content), 'NEARAI_RESPONSE');
  requireValue(m.tool_calls === undefined || Array.isArray(m.tool_calls), 'NEARAI_RESPONSE');
  const calls = m.tool_calls ?? [];
  requireValue(calls.length ? choice.finish_reason === 'tool_calls' : choice.finish_reason === 'stop', 'NEARAI_INCOMPLETE');
  const blocks = [];
  if (m.reasoning_content) blocks.push({ type: 'reasoning', text: m.reasoning_content });
  if (m.content) blocks.push({ type: 'text', text: m.content });
  const ids = new Set(), names = new Set(request.tools?.map(t => t.function.name));
  for (const call of calls) {
    requireValue(call.type === 'function' && nonempty(call.id) && !ids.has(call.id) &&
      names.has(call.function?.name) && text(call.function?.arguments), 'NEARAI_RESPONSE');
    ids.add(call.id);
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { throw new GateError('NEARAI_RESPONSE'); }
    requireValue(args !== null && typeof args === 'object' && !Array.isArray(args), 'NEARAI_RESPONSE');
    blocks.push({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  requireValue(blocks.length > 0, 'NEARAI_RESPONSE');
  const chunks = [];
  blocks.forEach((block, index) => {
    chunks.push({ type: 'block-start', index, blockType: block.type });
    chunks.push(block.type === 'text' || block.type === 'reasoning'
      ? { type: block.type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: block.text }
      : { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments });
    chunks.push({ type: 'block-end', index, block });
  });
  if (response.usage !== undefined) {
    const u = response.usage, cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    for (const n of [u.prompt_tokens, u.completion_tokens, cached]) requireValue(Number.isSafeInteger(n) && n >= 0, 'NEARAI_RESPONSE');
    requireValue(cached <= u.prompt_tokens, 'NEARAI_RESPONSE');
    const usage = { inputTokens: u.prompt_tokens - cached, outputTokens: u.completion_tokens, cacheReadTokens: cached };
    const reasoning = u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens;
    if (reasoning !== undefined) {
      requireValue(Number.isSafeInteger(reasoning) && reasoning >= 0 && reasoning <= u.completion_tokens, 'NEARAI_RESPONSE');
      requireValue(u.reasoning_tokens === undefined || u.reasoning_tokens === reasoning, 'NEARAI_RESPONSE');
      usage.reasoningTokens = reasoning;
    }
    if (u.total_tokens === u.prompt_tokens + u.completion_tokens) usage.totalTokens = u.total_tokens;
    chunks.push({ type: 'usage', usage });
  }
  chunks.push({ type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } });
  return chunks;
}
