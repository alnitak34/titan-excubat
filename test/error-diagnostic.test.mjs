import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureDiagnostic, transferDiagnostic, getDiagnostic } from '../src/error-diagnostic.mjs';

test('sanitized SDK reason survives both error boundaries without retaining private data', () => {
  const raw = Object.assign(new Error('PRIVATE_PROMPT'), {headers:{authorization:'PRIVATE_KEY'},
    failure:{code:'provenance.deployment_images_invalid', details:{reason:'invalid_docker_compose', input:'PRIVATE_INPUT'}}});
  const gate = captureDiagnostic(new Error('NEARAI_VERIFICATION'), raw);
  const publicError = transferDiagnostic(new Error('NEAR AI response withheld'), gate);
  const report = getDiagnostic(publicError);
  assert.equal(report.chain[0].reason, 'invalid_docker_compose');
  assert.equal(report.chain[0].code, 'provenance.deployment_images_invalid');
  assert.equal(JSON.stringify([gate, publicError, report]).includes('PRIVATE'), false);
  assert.equal(publicError.cause, undefined);
  assert.equal(gate.cause, undefined);
  report.chain[0].code = 'MUTATED';
  assert.notEqual(getDiagnostic(publicError).chain[0].code, 'MUTATED');
});

test('foreign error diagnostic properties cannot inject a snapshot', () => {
  const error = Object.assign(new Error(), {diagnostic:{secret:'PRIVATE'}});
  assert.equal(getDiagnostic(error), undefined);
  assert.equal(getDiagnostic(transferDiagnostic(new Error(), error)), undefined);
});
