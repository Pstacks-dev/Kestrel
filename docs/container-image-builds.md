# Kestrel container image builds

Kestrel can build and publish an OCI image from a successful pipeline commit using a trusted worker's Docker engine.

## Supported registries

- GitHub Container Registry (ghcr.io)
- Docker Hub (docker.io)

The build job is created as a separate Kestrel pipeline run, pins the source commit SHA, and publishes an immutable digest. The digest can be selected in the hosting-provider deployment form. Providers receive an image digest, not a mutable tag.

## Setup

1. Create registry credentials with the minimum package-write permissions (GHCR: a PAT with write:packages; Docker Hub: an access token).
2. In Kestrel, add the registry username and token/password to Project → Secrets. The default secret names are REGISTRY_USERNAME and REGISTRY_PASSWORD; the build form allows different names.
3. Choose a successful source pipeline run in Settings → Hosting Providers.
4. Select the registry, namespace/repository, Dockerfile path, and build context. The tag defaults to a short tag derived from the commit SHA.
5. Start the build. The worker performs registry login using stdin, builds, pushes, inspects the registry digest, then removes temporary Docker auth and its local image.
6. Once the build is successful, select its immutable image in the deployment form.

## Worker requirements and security

- Container builds are dispatched only to Node/Docker workers with the Docker CLI and Docker socket configured.
- The Dockerfile is executed by Docker's build engine. Do not run container-build jobs on shared worker hosts that contain unrelated workloads or sensitive host data. Prefer dedicated, isolated worker hosts and a restricted registry token.
- Registry credentials are project secrets, decrypted for the worker, passed to docker login via stdin, stored in a temporary DOCKER_CONFIG, and removed after the job. They are not passed as Docker build arguments or environment variables to the build.
- Build contexts and Dockerfile paths are validated and symlink escapes are rejected.
- The source commit is immutable; the published image reference is repository@sha256:...
- Build/push is not automatically retried because a push may have completed before a connection failure; queue another build after inspecting the run.
- Only GHCR and Docker Hub are supported initially. Private registries, automatic image rollback, and real-account smoke testing remain follow-up work.

## Project secrets

Create these project secrets (or custom names supplied in the build form):

- REGISTRY_USERNAME
- REGISTRY_PASSWORD

Never paste registry tokens into pipeline logs or build arguments.
