# ADR 0008: TLS terminates at the ingress

The API process does not terminate public TLS. Production startup requires `FAD_INGRESS_TLS=terminated`, `FAD_TRUST_PROXY=true`, and an explicit `FAD_TRUSTED_PROXIES` CIDR list. `trustProxy: true` (trust every hop) is rejected. Production `DATABASE_URL` must set `sslmode=require`, `verify-ca`, or `verify-full`.

Development cleartext is allowed only when the process binds a loopback address, or when `FAD_DEV_LOOPBACK_PUBLISH=true` records that Compose publishes `127.0.0.1` only. A missing or weak `FAD_API_KEY_PEPPER_V1` always fails startup. The pepper is the UTF-8 value of that variable and must be at least 32 bytes with at least 8 distinct byte values.

Contract check: unit tests and a process spawn cover missing pepper, weak pepper, production cleartext, and trust-all proxy.
