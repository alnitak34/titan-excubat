# Security disposition — 2026-11-10 local candidate

## Elliptic advisory

GHSA-848j-6mx2-7j84 remains present in the pinned graph and is not patched by
this project. Static review of SHA512-integrity-matched SDK 0.2.1 and DCAP 0.7.0
archives found no use of the vulnerable Elliptic signing operation on the traced
Node verification path. DCAP uses native Node verification; its browser fallback
uses Elliptic keyFromPublic/verify. The SDK's response verification and E2EE paths
use ethers/tweetnacl, not Elliptic signing. This is a scoped source assessment,
not dynamic coverage or a complete audit of the host's dependency graph.

Do not suppress the advisory as fixed. Reassess on dependency changes or if the
host separately uses Elliptic for signing.
Source: https://github.com/advisories/GHSA-848j-6mx2-7j84 .

## Exact proxy revision

The prior policy accepted provenance from the specified official repository and
workflow without requiring a specific source revision. It now also requires
7924418b5eacb396a12ada208b0f2f0c82ec6d1d for nearaidev/vllm-proxy-rs. That
official change restricts OHTTP inner routes and disables redirects. The pinned
SDK supports exact commit matching against authenticated provenance. Any other
revision must fail this policy, including newer revisions until reviewed.

Source change: https://github.com/nearai/inference-proxy/commit/7924418b5eacb396a12ada208b0f2f0c82ec6d1d .
Official compose repin: https://github.com/nearai/cvm-compose-files/commit/3ea271967dc297e0a2b7a3c37a00c55f8bab55b6 .

This enforces a reviewed build revision, not current runtime inventory, complete
engine remediation, or freedom from vulnerabilities. The engine v13 recipe at
https://github.com/nearai/cvm-compose-files/commit/ab7eeee2e3b480d4f5644d7988586e8f5765a969
was documented as prepared, not published or deployed; it is not used as a
verified production image here.

## Validation and release boundary

52 local unit tests passed, including propagation of the required commit and
zero output when the supplied provenance checker rejects it. These new tests
simulate the checker; they do not verify real provenance signatures.

The previous 50-unit/42-integration record predates this policy change. A fresh
isolated actual-package integration run is required before declaring this
candidate integration-validated. No local dependency installation or paid live
inference was performed for this change.

Six additional integration cases call the actual SDK's exported image verifier
with the production commit policy: matching revision, different revision, and
certificate/statement source mismatch, for SLSA v1 and v0.2. Sigstore signature,
certificate parsing and TUF trust are simulated explicitly. These tests exercise
the SDK's source-policy enforcement, not genuine signed attestations. Execution
status must be read from the candidate's own CI run, not the historical logs.

Post-incident current deployment verification remains NOT ESTABLISHED. Preserve
the offline demo labels and historical-live-record labels. Do not use the client
as sole authorization for tools, payments or access to sensitive data.
