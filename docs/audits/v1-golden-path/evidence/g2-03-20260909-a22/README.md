# G2-03 Codex Primary Evidence

This directory is the durable, sanitized completion evidence for clean-room
run `g2-03-20260909-a22`.

The retained files preserve their original evidence-relative paths and bytes:

1. `transcript/events.ndjson`: complete 144-event external-agent transcript
2. `manifest.json`: controller-owned run result and digest inventory for all
   149 source artifacts
3. `verifier/report.json`: independent terminal verdict
4. `environment/isolation.json`: provider, sandbox, identity, release, and
   cleanup attestation
5. `quality/index.json`: initial, fault, repaired, and final evaluation records
6. `sessions/index.json`: semantic multiplayer, stale-runtime recovery, reset,
   and cleanup records
7. `visual/index.json`: capture metadata, digests, and controller observations
8. `release/verified-release.json`: independently inspected hidden release

The larger PNG and ZIP binaries and repetitive leaf command/session outputs
remain in the local operator bundle indexed by the manifest. The durable set
contains the complete transcript and every decisive machine-readable index,
including the SHA-256 identities of those omitted binaries and leaves. It is
sufficient to audit the claim without turning the source repository into a
runtime-artifact store.

`manifest.json` is the canonical owner of the transcript identity and complete
149-artifact digest inventory. Maintained prose deliberately does not restate
those generated identities.

This proof certifies only the Codex primary lane (`G2-03`). It does not certify
the independent Claude Desktop lane (`G2-04`), final cross-client replay
(`G2-05`), or production launch.
