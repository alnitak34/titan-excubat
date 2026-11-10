import { safeDiagnostic } from './safe-diagnostic.mjs';

// Never attach raw provider errors (messages, headers or plaintext) as causes.
const diagnostics = new WeakMap();
export function captureDiagnostic(target, source) {
  diagnostics.set(target, safeDiagnostic(source));
  return target;
}
export function transferDiagnostic(target, source) {
  const snapshot = diagnostics.get(source);
  if (snapshot) diagnostics.set(target, snapshot);
  return target;
}
export function getDiagnostic(error) {
  const snapshot = diagnostics.get(error);
  return snapshot ? structuredClone(snapshot) : undefined;
}
