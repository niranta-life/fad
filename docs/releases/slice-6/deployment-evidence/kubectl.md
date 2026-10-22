# kubectl

`kubectl apply` is not the Slice 6 Docker gate.

The supplied operations text deploys one OCI image, a separate migration job, and REST and MCP replicas. Its completion list asks for container logs, the image digest, curl, MCP, SDK, race tests, performance, RLS, restore, one Git commit, and a CI run id. It does not name `kubectl`.

The supplied matrix row R12 is "Docker image non-root and startup readiness checks pass". That row is PASS on `sha256:e5861d49221dc9d4598c67e521f70720f3f6a50aba4ab388fe965eff907e2473`. The later image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc` also reported uid 1000 at 2026-10-22T06:13:28.358Z and both replicas ready at 2026-10-22T06:13:29.655Z. That Docker result is not a kubectl pass. R19 is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. `kubectl apply` is not a pass.

In this repository, `docs/operations/RUNBOOK.md` starts the local stack with `docker compose -f deploy/docker/compose.yaml`. `deploy/k8s/policy-overlay.yaml` says it is an overlay for an existing Deployment and that it does not create a cluster. The overlay sets `FAD_POLICIES_ENABLED`. It does not set `FAD_ENFORCEMENT_CODE_ENABLED`. There is no base Deployment and no `deploy/OPERATIONS.md` in the repository.

Command time: 2026-10-22T05:39:36Z. Client: kubectl v1.34.1. `kubectl config get-contexts` printed a header and no context. `kubectl cluster-info` was refused by `http://localhost:8080`. `kind`, `minikube`, `k3d`, and `k3s` are absent. `kubectl apply -f deploy/k8s/policy-overlay.yaml` did not create an object. The error was `connection refused`. A client dry-run with `--validate=false` at 2026-10-22T05:39:55Z returned the same refusal. Log: `kubectl.txt`.

This result is not a pass. No Kubernetes rollout was applied. It is not matrix row R12 or R19.
