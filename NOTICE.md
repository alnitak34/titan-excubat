# Attribution

This experimental implementation follows the public design request by **think-in-universe**:
https://github.com/nearai/inference-sdk/issues/108

The integration idea is not claimed as our invention. Cryptographic verification,
attestation, TLS binding and field encryption are delegated to the NEAR AI SDK;
this package adds a response-release boundary and Harness protocol translation.

Reference projects, both declared MIT in the inspected package manifests:

- https://github.com/nearai/inference-sdk/tree/b6049e1ebe6e50ced10e8ac22f34d5f46cb73dbc
- https://github.com/deepseek-ai/deepseek-harness/tree/8bd073392eef6f54e921a093b95076248eb08cbb

Local reference copies under research/upstream are excluded from package files.
No upstream implementation is vendored into src. This implementation is licensed
under MIT; see LICENSE. Third-party dependencies retain their own licenses.
