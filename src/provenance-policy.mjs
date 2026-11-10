import { deploymentPolicy } from './policy.mjs';

// Internal composition seam for offline tests. No configuration can disable it.
// The public plugin supplies the real SDK helpers, never caller-supplied verifiers.
export function provenancePolicies(models, { verifyGateway, verifyModel }) {
  const approveMeasurements = deploymentPolicy(models);
  return {
    gateway: async deployment => {
      await verifyGateway({ appCompose: deployment.appCompose,
        imagePolicies: { 'nearaidev/cloud-api': {
          repository: 'nearai/cloud-api', workflow: '.github/workflows/build.yml' } } });
    },
    model: async params => {
      approveMeasurements(params);
      await verifyModel({ deployment: params.deployment,
        imagePolicies: { 'nearaidev/vllm-proxy-rs': {
          repository: 'nearai/inference-proxy', workflow: '.github/workflows/build.yml',
          // Reviewed OHTTP route restriction. New revisions require explicit review.
          // This pins build provenance, not current-runtime or engine patch status.
          commit: '7924418b5eacb396a12ada208b0f2f0c82ec6d1d' } },
        composeManagerImagePolicy: { imageRepository: 'nearaidev/compose-manager',
          repository: 'nearai/compose-manager', workflow: '.github/workflows/build.yml' } });
    },
  };
}
