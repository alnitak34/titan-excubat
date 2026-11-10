import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { verifyModelResponse } from '@nearai/inference-sdk/node';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

// Real Ed25519 signatures; synthetic trusted signer, NOT a verified hardware quote.
export function signedFixture(body, response) {
  const requestBody = Buffer.from(JSON.stringify(body));
  const responseBody = Buffer.from(JSON.stringify(response));
  const signedText = `${body.model}:${sha(requestBody)}:${sha(responseBody)}`;
  const signer = { signingAlgo: 'ed25519', signingAddress: publicKey };
  const signature = { kind: 'provider_tee', signedText, signer,
    signature: sign(null, Buffer.from(signedText), keys.privateKey).toString('hex') };
  return { requestBody, responseBody, signature, attestation: { signer } };
}

export function checkFixture(fixture) {
  // This is the real published SDK signature verifier, not a boolean mock.
  verifyModelResponse(fixture);
}

export function toolResponse(id = 'reply-1') {
  return { id, choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: 'Calling the harmless test tool.',
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'hello', arguments: '{}' } }],
  } }] };
}
export function finalResponse(id = 'reply-2') {
  return { id, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }] };
}
