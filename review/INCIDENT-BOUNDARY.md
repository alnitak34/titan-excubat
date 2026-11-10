# Inference software compromise: verification boundary

Review date: 2026-11-10.

NEAR AI's [incident report](https://near.ai/blog/security-incident-report-sglang-vulnerability)
states that a SGLang vulnerability allowed code execution on an inference server
and possible observation of requests on November 8, including confidential ones.
The provider reports remediation. This project has not independently established
the mapping between a patched inference image and its historical approved deployment.

EXCUBAT must not be described as having prevented or detected that incident.
Attestation, response signatures and selected build provenance do not establish
absence of exploitable vulnerabilities inside an approved environment. End-to-end
encryption does not protect plaintext from compromised software at its endpoint.

Historical successful inference records establish the checks observed at the time;
they do not establish that those requests were unexposed or processed after a patch.
The November 8 synthetic HELLO request coincides with the incident date, but the
affected-server identity and exact exposure interval for our request are unknown.

Before claiming post-incident live validation, obtain an official patched version
or image digest, establish its relation to authenticated deployment evidence, and
independently review any required approval changes. Do not automatically trust new
measurements supplied by the service under review. A successful attestation alone
does not close this evidence gap. Current status: NOT ESTABLISHED.

Offline failure tests remain useful for the client's verification boundary. They
do not reproduce this server-side exploit or validate the provider's remediation.
