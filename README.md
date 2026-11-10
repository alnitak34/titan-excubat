# TITAN EXCUBAT

Experimental NEAR AI verified provider for DeepSeek Harness.

The adapter buffers a completion and releases no text, reasoning or tool-call
chunks until the configured SDK checks pass and `verifyResponse(id)` returns
`provider_tee` for the same response ID. It validates the complete translated
response before releasing its first chunk. See [gate](src/gate.mjs),
[protocol](src/protocol.mjs) and [production configuration](src/plugin.mjs).

Cryptography, attestation, TLS binding and field encryption are supplied by the
NEAR AI SDK. Our contribution is the release boundary, Harness translation,
lifecycle controls and sanitized diagnostics. The original integration proposal
is credited in [NOTICE.md](NOTICE.md).

## Try offline

Using an existing Node >=24.22.1, from this directory:

```sh
node scripts/demo.mjs
node --test test/*.test.mjs
```

No installation, credential or inference is needed for these commands. The demo
uses the real gate with a simulated SDK: pending verification, gateway-only
verdicts and rejected verification release nothing. It counts tool-call chunks;
it does not execute tools or verify real cryptography. It also displays a
separately labelled historical result from [the reduced record](records/live-loop.json).

## Evidence and its limits

- Security-policy revision: public run [42861197288](https://github.com/alnitak34/titan-excubat/actions/runs/42861197288)
  passed 52 unit and 48 integration tests at `7e5317df647308c3c4e1037404d8da0c1c4b0115`.
  Included [unit](review/logs/security-unit.tap) and [integration](review/logs/security-integration.tap)
  logs preserve those results. Six new cases exercise the real SDK's source-commit
  checks with a simulated Sigstore/TUF boundary. They are not live attestation or
  genuine provenance-signature validation. Later edits only document this result.
- Local unit suite: 52 passed, zero failed on 2026-11-10. These tests exercise
  supplied verdicts, translation, lifecycle, transport limits and diagnostics.
- Candidate integration run: [42758734014](https://github.com/alnitak34/near-agent-verification-lab/actions/runs/42758734014)
  passed 50 unit and 42 integration tests at `f3657c94202770c1d1d80a5909e1a4b9bab9a53b`.
  Read the included [unit log](review/logs/unit.tap), [integration log](review/logs/integration.tap)
  and [reviewer guide](review/START-HERE.txt). Actual Harness/SDK code ran with
  controlled network, hardware-quote and provenance fixtures. This is not live
  hardware validation. Later licensing/documentation changes are described in
  [release notes](RELEASE-NOTES.txt). The subsequent exact proxy-commit policy
  and its two new unit tests are NOT covered by that historical integration run.
- Recorded live loop: [42605913021](https://github.com/alnitak34/near-agent-verification-lab/actions/runs/42605913021/job/129121752100)
  at `121f47b06aa5810140b383653683f1feafb5607b`: two adapter calls, one harmless
  in-memory tool, matching final receipt, zero retries. One successful sample
  does not establish reliability or production security.

The source runs are in a private laboratory; readers may lack access. The
included JSON is a historical summary, not a signed independently verifiable
receipt. Earlier second-turn and provenance failures remain unexplained; a
later success does not resolve their causes. No live inference was rerun during
this documentation preparation. Integration tests were not rerun locally.

## Reproduce integration tests

The committed package-lock.json pins the dependency graph. In a separate,
explicitly approved environment where installation is permitted:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:integration
```

This downloads dependencies. Integration test processes use a no-network guard.
The optional manual workflow in `.github/workflows/verified-provider.yml`
performs installation on an ephemeral runner; review account billing before
running it. The public staging copy uses package files at repository root.
No live-inference workflow is included in that copy.
Evidence uploads are disabled by default; test results remain in the run logs.
Enable `retain_evidence` only after reviewing artifact storage allowance.

The manifest pins SDK 0.2.1 and Harness alpha packages and overrides Zod to
4.6.6. The [2026-11-10 npm audit](review/dependency-audit.json) reports zero high/critical/moderate entries and three low package entries for one unresolved Elliptic advisory. This is not a vulnerability-free clearance. A dependency's
npm overrides do not control its host application's dependency resolution.
Published package equivalence to the originally inspected source commits has
not been established. See [package.json](package.json) and the lockfile.
The exact locked SDK/DCAP archives were additionally inspected for the Elliptic
advisory: the vulnerable signing operation is not used in the statically traced
verification path. This does not remove or fix the dependency. See
[security disposition](review/SECURITY-DISPOSITION.md).

## Verification policy

The production adapter enables E2EE, TLS binding and explicit model/OS/compose
measurement approval. It requires selected-image provenance for the configured
NEAR repositories/workflows and does not fall back when verification fails.
The proxy policy also requires the exact reviewed source revision
`7924418b5eacb396a12ada208b0f2f0c82ec6d1d`; newer revisions require review too.
Gateway and manager policies remain repository/workflow checks. This is not
approval of every image or proof of the current runtime. See [measurement policy](src/policy.mjs) and
[provenance policy](src/provenance-policy.mjs).

Deployment measurements must be independently approved. Never automatically
trust the measurements returned by the same request being checked. Credentials
belong in the host environment, never the website or repository.

## Security boundaries

- Attestation and signatures do not prove that the approved inference software
  is free of vulnerabilities. Compromise inside an approved environment may be
  outside this client's detection boundary. Selected build provenance is not
  proof of a patched SGLang version. See [incident review](review/INCIDENT-BOUNDARY.md).
- A signature is not tool authorization, truth, or proof of exact model weights.
  The host must validate tool arguments and enforce permissions.
- The local process and tools see plaintext. E2EE covers SDK-supported fields,
  not all metadata. Garbage collection does not guarantee secure erasure.
- Defaults: one concurrent request, 120000 ms deadline, 2048 output tokens,
  1 MiB serialized request and parsed-completion limits.
- The pinned transport caps delivered response-body bytes at 4 MiB before SDK
  buffering/parsing. SDK decompression may occur before this boundary. Separate
  attestation/provenance requests are outside the cap; it is not an OS memory
  limit. The version-dependent hook must be rechecked on SDK upgrades.
- An operation that ignores cancellation keeps its slot until it settles;
  this bounds orphan operations but can leave the adapter busy indefinitely.
  Cancellation cannot revoke chunks already released or actions already begun.
- Text, string `reasoning_content` and ordinary function tools are supported.
  Unsupported content/order, truncated output and malformed calls are rejected.
  Verification does not establish the correctness of model reasoning.

See [transport](src/bounded-transport.mjs), [gate](src/gate.mjs) and
[protocol](src/protocol.mjs) for enforcement. This remains experimental, without
an independent cryptographic audit or production security clearance.

## Release status

Published source and included test evidence: https://github.com/alnitak34/titan-excubat.
Historical source runs remain private; their exported integration logs are included in review/.
The implementation is licensed under [MIT](LICENSE), copyright 2026 alnitak34. No claim of
adoption, novelty, comparative superiority or hackathon outcome is made.
The website is an illustrative interface, not a live verification service.

The working-folder history and billing records are deliberately absent from
the staging copy. Historical failures are disclosed above. Attribution remains
in [NOTICE.md](NOTICE.md); no upstream implementation is vendored into `src`.
