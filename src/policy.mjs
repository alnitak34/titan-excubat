import { requireValue } from './protocol.mjs';

export function deploymentPolicy(models) {
  const approved = new Map();
  requireValue(Array.isArray(models) && models.length > 0, 'NEARAI_CONFIG');
  for (const m of models) {
    requireValue(typeof m.id === 'string' && m.id.length > 0 && !approved.has(m.id), 'NEARAI_CONFIG');
    for (const value of [m.osImageHash, m.composeHash])
      requireValue(typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value), 'NEARAI_CONFIG');
    approved.set(m.id, { osImageHash: m.osImageHash, composeHash: m.composeHash });
  }
  return ({ model, deployment }) => {
    const expected = approved.get(model), measured = deployment?.runtimeMeasurements;
    requireValue(expected && measured?.osImageHash === expected.osImageHash &&
      measured?.composeHash === expected.composeHash, 'NEARAI_DEPLOYMENT');
  };
}
