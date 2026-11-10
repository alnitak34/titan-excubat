import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerificationError, ApiError, getSdkError } from '@nearai/inference-sdk/node';
import { safeDiagnostic } from '../../scripts/safe-diagnostic.mjs';

test('actual SDK provenance error retains failure.code and status through wrapper', () => {
  const inner = new VerificationError({code:'provenance.compose_file_request_failed',
    details:{repository:'nearai/cvm-compose-files',commit:'a'.repeat(40),file:'PRIVATE_FILE',status:403},retryable:false});
  const wrapper = new Error('PRIVATE_PROMPT',{cause:inner});
  assert.equal(inner.code,undefined); // Regression: the previous diagnostic read this.
  assert.equal(getSdkError(wrapper),inner);
  const report=safeDiagnostic(wrapper);
  assert.equal(report.chain[1].code,'provenance.compose_file_request_failed');
  assert.equal(report.chain[1].httpStatus,403);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});
test('actual SDK HTTP failure reports status without serializing its message', () => {
  const e = new ApiError({code:'api.http_status',details:{resource:'image_provenance',status:429},retryable:true});
  const report=safeDiagnostic(e);
  assert.equal(report.chain[0].code,'api.http_status');
  assert.equal(report.chain[0].httpStatus,429);
  assert.equal(report.chain[0].retryable,true);
});
