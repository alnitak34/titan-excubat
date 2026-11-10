// Only fixed labels and bounded numbers may leave this classifier.
// Never serialize arbitrary error names, codes, messages, stacks or properties.
// Fixed code allowlist extracted from pinned SDK b6049e1 js/src/utils/errors.ts.
import sdkCodes from './sdk-failure-codes.json' with { type: 'json' };
const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError',
  'AbortError', 'TimeoutError', 'APIError', 'APIConnectionError',
  'AuthenticationError', 'PermissionDeniedError', 'BadRequestError',
  'RateLimitError', 'VerificationError', 'ApiError']);
const codes = new Set(['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_URL',
  'NEARAI_DEPLOYMENT', ...sdkCodes]);
// Fixed SDK enum, never arbitrary failure.details or error.message.
const imageReasons = new Set(['empty_policy', 'invalid_app_compose', 'invalid_docker_compose',
  'service_missing', 'unresolved_image', 'image_missing', 'image_not_pinned']);
const categories = [
  ['MISSING_PROPERTY', /Cannot read properties of (undefined|null)/],
  ['NOT_CALLABLE', /is not a function/],
  ['FETCH_FAILED', /fetch failed|Failed to fetch/],
  ['BODY_ALREADY_USED', /body.*(already|unusable)|already.*(body|consumed)/i],
  ['INVALID_URL', /Invalid URL/],
  ['ABORTED', /operation was aborted|signal.*aborted/i],
  ['INSUFFICIENT_BALANCE_TEXT', /insufficient (balance|credits)|not enough credits/i],
];
function own(value, key) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
export function safeDiagnostic(error) {
  const chain = [], seen = new Set();
  for (let value = error; value && chain.length < 4 && !seen.has(value); value = own(value, 'cause')) {
    seen.add(value);
    let kind = 'UNKNOWN';
    if (value instanceof TypeError) kind = 'TypeError';
    else if (value instanceof RangeError) kind = 'RangeError';
    else if (value instanceof SyntaxError) kind = 'SyntaxError';
    else if (value instanceof Error) kind = 'Error';
    const failure = own(value, 'failure'), details = own(failure, 'details');
    const name = own(value, 'name'), code = own(failure, 'code') ?? own(value, 'code');
    const status = own(details, 'status') ?? own(value, 'status');
    if (names.has(name)) kind = name;
    const message = own(value, 'message');
    chain.push({ kind, code: codes.has(code) ? code : 'UNCLASSIFIED',
      reason: code === 'provenance.deployment_images_invalid' && imageReasons.has(own(details, 'reason'))
        ? own(details, 'reason') : undefined,
      retryable: typeof own(failure, 'retryable') === 'boolean' ? own(failure, 'retryable') : undefined,
      httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
      category: typeof message === 'string'
        ? categories.find(([, pattern]) => pattern.test(message.slice(0, 4096)))?.[0] ?? 'UNCLASSIFIED'
        : 'NO_MESSAGE' });
  }
  return { chain: chain.length ? chain : [{ kind: 'UNKNOWN', code: 'UNCLASSIFIED', category: 'NO_MESSAGE' }] };
}
