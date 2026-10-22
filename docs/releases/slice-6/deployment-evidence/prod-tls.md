# Production TLS boot

## Tested image

Image: `fad-api:slice6`

Image id: `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`

Time: 2026-10-22T06:27:45Z through 2026-10-22T06:27:50Z

Result: PASS. Log: `prod-tls-f3a44c87.log`.

Postgres served TLS on a separate container. `SHOW ssl` returned `on`. `pg_hba.conf` used local trust, `hostssl` scram, and `hostnossl` reject. A cleartext TCP login was rejected. A `sslmode=require` login returned `on`. Bootstrap applied the Slice 0 through Slice 6 migrations, including `20261021_006_policy_enforcement`. The API role was `fad_app`.

| Check | Time | Result |
| --- | --- | --- |
| API state | 2026-10-22T06:27:50Z | `running 0`. Started `2026-10-22T06:27:48.217892206Z`. |
| `GET /health/live` | 2026-10-22T06:27:50Z | 200 `{"status":"ok"}`. Request `8db22478-4456-4958-a6c0-4154ae728436`. |
| `GET /health/ready` | 2026-10-22T06:27:50Z | 200 `{"status":"ready"}`. Request `baaa791c-d03a-4cf9-918b-a38a606f9a9a`. |
| `pg_stat_ssl` | 2026-10-22T06:27:50Z | `fad-api-1`, ssl true, TLSv1.3, `TLS_AES_256_GCM_SHA384`. |

`DEPLOY-PROD-BOOT` in `image-rerun-f3a44c87.log` exited 1 against `fad-s0-pg`. That line is a refusal check, not this boot.

## Previous image

Image id: `sha256:e5861d49221dc9d4598c67e521f70720f3f6a50aba4ab388fe965eff907e2473`

Postgres 16.15 served TLS on a separate container. `SHOW ssl` returned `on`. `pg_hba.conf` allowed local sockets, required `hostssl` for TCP, and rejected `hostnossl`. A cleartext TCP login was rejected. A `sslmode=require` login returned `on`.

The API used `NODE_ENV=production`, `FAD_INGRESS_TLS=terminated`, `FAD_TRUST_PROXY=true`, `FAD_TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12,127.0.0.1/32`, and `DATABASE_URL` with `sslmode=require`. The server certificate was signed for `DNS:fad-s6-pg-tls`. Node trusted that CA through `NODE_EXTRA_CA_CERTS`. The migrator command was `node apps/migrator/dist/main.js bootstrap` on that empty database. It applied the Slice 0 through Slice 6 migrations, including `20261021_006_policy_enforcement`.

Result: PASS.

| Check | Time | Result |
| --- | --- | --- |
| API state | 2026-10-22T05:34:55Z | `running 0`. Started `2026-10-22T05:34:53.876312115Z`. |
| `GET /health/live` | 2026-10-22T05:34:55Z | 200 `{"status":"ok"}`. Request `8c3cd4b7-78f9-4afe-bf9f-cb0ce142fa7c`. |
| `GET /health/ready` | 2026-10-22T05:34:55Z | 200 `{"status":"ready"}`. Request `7f2f8376-452b-4bd9-9341-07164f5fabec`. |
| `pg_stat_ssl` | 2026-10-22T05:34:55Z | `fad-api-1`, ssl true, TLSv1.3, `TLS_AES_256_GCM_SHA384`. |

Log: `prod-tls-boot.log`.

An earlier boot at 2026-10-22T05:30:48.720Z against a self-signed certificate exited 1. The message was `self-signed certificate`. That log is `prod-tls-self-signed.log`. The installed `pg` client treats `sslmode=require` as `verify-full` and replaces the pool `rejectUnauthorized: false` setting. This boot trusted the CA. It did not turn verification off.

`fad-s0-pg` still has no TLS. The refusal at 2026-10-22T05:16:41.042Z in `image-rerun.log` is that check. It is not this boot.

This database had no tenant and no agent. The check is startup, readiness, and a TLS session. It is not the enforcement journey. The containers were removed after the log was copied. The shared database `fad` was not changed.
