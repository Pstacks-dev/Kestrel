import test from 'node:test';
import assert from 'node:assert/strict';
import { createDigitalOceanDeployment } from '../server/lib/hosting-digitalocean.mjs';

test('creates a DigitalOcean Docker service using the configured monorepo build context', async () => {
  const calls = [];
  const commitSha = 'a'.repeat(40);
  const result = await createDigitalOceanDeployment({
    accessToken: 'do-token',
    repositoryUrl: 'https://github.com/acme/monorepo',
    branch: 'main',
    commitSha,
    projectName: 'API Service',
    profile: {
      runtime: 'node',
      isStatic: false,
      needsContainer: true,
      rootDir: 'apps/api',
      dockerfilePath: './Dockerfile',
      dockerContext: '.',
    },
    env: {},
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        app: {
          id: 'app-123',
          live_url: 'https://api.example.ondigitalocean.app',
          in_progress_deployment: {
            id: 'dep-123',
            phase: 'PENDING',
            services: [{ source_commit_hash: commitSha }],
          },
        },
      }), { status: 201 });
    },
  });

  assert.equal(calls.length, 1);
  const spec = JSON.parse(calls[0].options.body).spec;
  const service = spec.services[0];
  assert.equal(service.source_dir, 'apps/api');
  assert.equal(service.dockerfile_path, 'apps/api/Dockerfile');
  assert.equal(service.github.repo, 'acme/monorepo');
  assert.equal(service.github.branch, 'main');
  assert.equal(service.github.deploy_on_push, false);
  assert.equal(service.environment_slug, undefined);
  assert.equal(service.build_command, undefined);
  assert.equal(service.run_command, undefined);
  assert.equal(result.projectId, 'app-123');
  assert.equal(result.deploymentId, 'dep-123');
});
