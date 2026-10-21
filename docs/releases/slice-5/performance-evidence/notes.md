# Performance evidence

Forty sequential `POST /v1/authorization/evaluate` calls ran against the rebuilt `fad-api:slice5` image `sha256:45fbe99e5656fdac4a3f07b703c356684c6520769bf252708ab70de122f48ba8`, container `1fdb0186a16b`, with the policy flag on. The run was 2026-10-21T22:33:29.425Z through 2026-10-21T22:33:31.724Z. Every sample returned 200, `allow`, `EXPLICIT_ALLOW`, and `not_enforced`. First sample `4707c496-82e2-4a86-b988-eb394c4175af`. Last sample `c98d2d8f-799c-41c0-94d2-7ecc1b09c990`. Numbers are in `evaluate-after-match.json`.

An earlier 40-call sample on image `sha256:a05a932ef2bbd271bd6b07b06ea778a9828dcf9ce5e1735dd41077ad4413f3b0` is `evaluate.json`. That image does not contain the match fix.

| Stat | Milliseconds |
| --- | --- |
| min | 2.28 |
| p50 | 2.9 |
| p95 | 4.98 |
| max | 5.55 |

The 100 ms p95 target held for this sample. The sample is one client, one container, and one active allow policy on a local network. It is not a capacity test. Slice 3 `PERF-01`, `PERF-02`, and `PERF-03` stayed `NOT RUN` in the historical suite. Request ids and the raw numbers for the rebuilt image are in `evaluate-after-match.json`.
