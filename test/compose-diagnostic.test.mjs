import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectedComposeActions } from '../scripts/compose-diagnostic.mjs';

test('retains startup before many updates and chooses latest of each SDK action', () => {
  const old = { action: 'compose_manager_started', image: 'repo/manager:old' };
  const start = { action: 'compose_manager_started', image: 'repo/manager:new' };
  const updates = Array.from({length: 8}, (_, i) => ({action: 'compose_up', file: `prod/${i}.yaml`}));
  const actions = [old, start, ...updates, {action: 'other', env: 'PRIVATE'}];
  const result = selectedComposeActions({composeManager:{actions}});
  assert.deepEqual(result.map(a => a.action), ['compose_up', 'compose_manager_started']);
  assert.equal(result[0].file, 'prod/7.yaml');
  assert.equal(result[1].image, 'repo/manager:new');
  assert.equal(actions.length, 11);
});

test('omits arbitrary fields, unsafe paths and marks bounded service truncation', () => {
  const result = selectedComposeActions({composeManager:{actions:[{
    action:'compose_up', file:'prod/../secret', commit:'PRIVATE', file_sha256:'PRIVATE',
    env:'PRIVATE', services:Array(40).fill('proxy')
  }]}});
  assert.equal(result[0].file, undefined);
  assert.equal(result[0].services.length, 32);
  assert.equal(result[0].servicesTruncated, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('missing or empty actions remain explicitly absent', () => {
  assert.deepEqual(selectedComposeActions({}), []);
  assert.deepEqual(selectedComposeActions({composeManager:{actions:[]}}), []);
});
