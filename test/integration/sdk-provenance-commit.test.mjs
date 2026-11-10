import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { provenancePolicies } from '../../src/provenance-policy.mjs';

// Actual SDK policy/schema enforcement after a SIMULATED Sigstore boundary.
// These fixtures are not signed attestations. No cryptographic verification,
// TUF trust, deployed image, TEE, or current-runtime claim follows from them.
let certificate;
let boundaryCalls = 0;
class PolicyError extends Error {}
class SimulatedIdentity { verify() {} }
class SimulatedIssuer { verify() {} }
class SimulatedAnyOf { async verify() {} }
class SimulatedRootProvider { async getTrustedRoot() { return {}; } }
class SimulatedSigstoreVerifier {
  async loadSigstoreRoot() {}
  async verifyDsse(bundle, policy) {
    boundaryCalls++;
    // Execute the SDK's real certificate/source policy callback. Only the
    // cryptographic acceptance and certificate parsing are simulated here.
    await policy.verify(certificate);
    return {
      payload: Buffer.from(bundle.dsseEnvelope.payload, 'base64'),
      payloadType: bundle.dsseEnvelope.payloadType,
    };
  }
}
mock.module('@freedomofpress/sigstore-browser', { namedExports: {
  AnyOf: SimulatedAnyOf, Identity: SimulatedIdentity,
  OIDCIssuer: SimulatedIssuer, OIDCIssuerV2: SimulatedIssuer,
  PolicyError, SigstoreVerifier: SimulatedSigstoreVerifier,
  TrustedRootProvider: SimulatedRootProvider,
} });
// Import after the boundary replacement; the SDK itself is not mocked.
const { verifyImageProvenance, VerificationError } = await import('@nearai/inference-sdk/node');

const approved = '7924418b5eacb396a12ada208b0f2f0c82ec6d1d';
const previous = 'b'.repeat(40); // Synthetic unapproved source revision.
const digest = `sha256:${'a'.repeat(64)}`;
const repository = 'https://github.com/nearai/inference-proxy';
const workflow = '.github/workflows/build.yml';
const ref = 'refs/heads/main';

async function productionPolicy() {
  const measurements = { osImageHash: 'a'.repeat(64), composeHash: 'b'.repeat(64) };
  let captured;
  const policies = provenancePolicies([{ id: 'test', ...measurements }], {
    verifyGateway: async () => {},
    verifyModel: async params => { captured = params.imagePolicies['nearaidev/vllm-proxy-rs']; },
  });
  await policies.model({ model: 'test', deployment: { runtimeMeasurements: measurements } });
  assert.equal(captured.commit, approved);
  return captured;
}

function fixture(version, statementCommit, certificateCommit = statementCommit) {
  certificate = {
    extSubjectAltName: { uri: `${repository}/${workflow}@${ref}` },
    extSourceRepositoryURI: { sourceRepositoryURI: repository },
    extSourceRepositoryRef: { sourceRepositoryRef: ref },
    extSourceRepositoryDigest: { sourceRepositoryDigest: certificateCommit },
  };
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ digest: { sha256: digest.slice(7) } }],
    predicateType: `https://slsa.dev/provenance/${version}`,
    predicate: version === 'v1' ? {
      buildDefinition: {
        externalParameters: { workflow: { repository, path: workflow, ref } },
        resolvedDependencies: [{ uri: `${repository}@${ref}`, digest: { gitCommit: statementCommit } }],
      },
    } : {
      invocation: { configSource: {
        uri: `${repository}@${ref}`, entryPoint: workflow, digest: { sha1: statementCommit },
      } },
    },
  };
  return JSON.stringify({
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      certificate: { rawBytes: 'SIMULATED_CERTIFICATE' },
      tlogEntries: [{ logIndex: '0', logId: { keyId: 'SIMULATED' },
        kindVersion: { kind: 'dsse', version: '0.0.1' }, canonicalizedBody: 'SIMULATED' }],
    },
    dsseEnvelope: { payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
      signatures: [{ sig: 'SIMULATED_SIGNATURE' }] },
  });
}

function rejectsFor(reason) {
  return error => {
    assert.ok(error instanceof VerificationError);
    assert.equal(error.failure.code, 'provenance.image_verification_failed');
    assert.deepEqual(error.failure.details.reasons, [reason]);
    return true;
  };
}

for (const version of ['v1', 'v0.2']) {
  test(`actual SDK accepts approved source policy after simulated Sigstore: ${version}`, async () => {
    const policy = await productionPolicy();
    const before = boundaryCalls;
    const result = await verifyImageProvenance({ digest, policy, bundles: [fixture(version, approved)] });
    assert.equal(result.commit, approved);
    assert.equal(result.digest, digest);
    assert.equal(boundaryCalls, before + 1);
  });
  test(`actual SDK rejects different source revision after simulated Sigstore: ${version}`, async () => {
    const policy = await productionPolicy();
    const before = boundaryCalls;
    await assert.rejects(verifyImageProvenance({ digest, policy,
      bundles: [fixture(version, previous)] }), rejectsFor('commit_mismatch'));
    assert.equal(boundaryCalls, before + 1);
  });
  test(`actual SDK rejects approved statement with different certificate source: ${version}`, async () => {
    const policy = await productionPolicy();
    const before = boundaryCalls;
    await assert.rejects(verifyImageProvenance({ digest, policy,
      bundles: [fixture(version, approved, previous)] }), rejectsFor('source_mismatch'));
    assert.equal(boundaryCalls, before + 1);
  });
}
