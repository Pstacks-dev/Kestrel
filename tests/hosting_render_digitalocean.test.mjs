import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRenderDeployment, deployRenderService, getRenderDeployment, getRenderDeploymentLogs, rollbackRenderDeployment,
} from '../server/lib/hosting-render.mjs';
import {
  createDigitalOceanDeployment, deployDigitalOceanApp, getDigitalOceanDeployment, rollbackDigitalOceanDeployment,
} from '../server/lib/hosting-digitalocean.mjs';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('creates a Render web service with autodeploy disabled and deploys the verified commit', async () => {
  const calls = [];
  const result = await createRenderDeployment({
    apiKey: 'render-token', ownerId: 'owner-123', repositoryUrl: 'https://github.com/acme/private-demo.git',
    branch: 'main', commitSha: 'a'.repeat(40), projectName: 'Demo App', profile: { runtime: 'node', isStatic: false }, env: { DATABASE_URL: 'postgres://secret' },
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST' && url.endsWith('/services')) return response({ service: { id: 'srv-1', serviceDetails: { url: 'https://demo.onrender.com' } } }, 201);
    if (url.endsWith('/services/srv-1/env-vars')) { assert.equal(options.method, 'PUT'); assert.equal(JSON.parse(options.body)[0].key, 'DATABASE_URL'); return response({}); }
    return response({ id: 'dep-1', status: 'created' }, 201);
  } });
  assert.equal(calls.length, 3);
  const service = JSON.parse(calls[0].options.body);
  assert.equal(service.autoDeployTrigger, 'off');
  assert.equal(service.repo, 'https://github.com/acme/private-demo');
  assert.equal(service.serviceDetails.runtime, 'node');
  assert.deepEqual(service.serviceDetails.envSpecificDetails, {
    buildCommand: 'npm install && npm run build',
    startCommand: 'npm start',
  });
  assert.equal(service.serviceDetails.plan, 'starter');
  assert.equal(service.serviceDetails.region, 'oregon');
  assert.equal(JSON.parse(calls[2].options.body).commitId, 'a'.repeat(40));
  assert.equal(result.serviceId, 'srv-1');
  assert.equal(result.deploymentId, 'dep-1');
});

test('uses framework-specific static output directories and configured build commands on Render', async () => {
  const cases = [
    { outputDirectory: 'public', buildCommand: 'npm run build:docs' },
    { outputDirectory: 'build', buildCommand: 'npm run build' },
    { outputDirectory: 'dist/site/browser', buildCommand: 'npm ci && npm run build' },
  ];
  for (const [index, config] of cases.entries()) {
    let serviceBody;
    await createRenderDeployment({
      apiKey: 'render-token', ownerId: 'owner-123',
      repositoryUrl: 'https://github.com/acme/private-demo',
      commitSha: String(index + 1).repeat(40), projectName: 'Static Demo',
      profile: { runtime: 'node', isStatic: true, outputDirectory: config.outputDirectory },
      buildCommand: config.buildCommand,
    }, {
      fetchImpl: async (url, options) => {
        if (url.endsWith('/services')) {
          serviceBody = JSON.parse(options.body);
          return response({ service: { id: `static-${index}` } }, 201);
        }
        if (url.endsWith('/deploys')) return response({ id: `deployment-${index}`, status: 'created' }, 201);
        return response({});
      },
    });
    assert.equal(serviceBody.serviceDetails.publishPath, config.outputDirectory);
    assert.equal(serviceBody.serviceDetails.buildCommand, config.buildCommand);
  }
});

test('rejects unsafe Render static publish paths before creating a service', async () => {
  const noNetwork = async () => assert.fail('Render API must not be called');
  await assert.rejects(createRenderDeployment({
    apiKey: 'render-token', ownerId: 'owner-123',
    repositoryUrl: 'https://github.com/acme/private-demo', commitSha: 'a'.repeat(40),
    profile: { isStatic: true, outputDirectory: '../outside' },
  }, { fetchImpl: noNetwork }), /Invalid Render static publish directory/);
});

test('retrieves bounded Render build and runtime logs for the connected workspace service', async () => {
  const calls = [];
  const logs = await getRenderDeploymentLogs({
    apiKey: 'render-token', ownerId: 'owner-123', serviceId: 'srv-logs',
  }, {
    now: Date.parse('2026-11-26T12:00:00.000Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('ownerId'), 'owner-123');
      assert.equal(parsed.searchParams.get('resource'), 'srv-logs');
      assert.equal(parsed.searchParams.get('startTime'), '2026-11-26T11:00:00.000Z');
      assert.equal(parsed.searchParams.get('endTime'), '2026-11-26T12:00:00.000Z');
      assert.equal(parsed.searchParams.get('limit'), '100');
      const types = parsed.searchParams.getAll('type');
      return response({ logs: types.includes('build')
        ? [{ id: 'build-1', timestamp: '2026-11-26T11:30:00.000Z', message: 'Build completed', labels: [{ name: 'level', value: 'info' }, { name: 'type', value: 'build' }] }]
        : [{ id: 'runtime-1', timestamp: '2026-11-26T11:31:00.000Z', message: 'Server ready', labels: [{ name: 'level', value: 'info' }, { name: 'type', value: 'app' }] }] });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(logs.build[0].message, 'Build completed');
  assert.equal(logs.runtime[0].message, 'Server ready');
  assert.equal(logs.unavailable, false);
  assert.match(logs.message, /service-scoped/);
});

test('rejects invalid Render log time ranges before making requests', async () => {
  await assert.rejects(getRenderDeploymentLogs({
    apiKey: 'render-token', ownerId: 'owner-123', serviceId: 'srv-logs',
    startTime: '2026-11-27T12:00:00.000Z', endTime: '2026-11-26T12:00:00.000Z',
  }, { fetchImpl: async () => assert.fail('Render API must not be called') }), /valid start and end timestamps/);
});

test('deploys, polls and rolls back a Render service', async () => {
  const deployed = await deployRenderService({ apiKey: 'x', serviceId: 'srv-1', commitSha: 'b'.repeat(40) }, {
    fetchImpl: async () => response({ id: 'dep-2', status: 'queued' }, 201),
  });
  assert.equal(deployed.deploymentId, 'dep-2');
  const current = await getRenderDeployment({ apiKey: 'x', serviceId: 'srv-1', deploymentId: 'dep-2' }, {
    fetchImpl: async (url) => url.endsWith('/deploys/dep-2')
      ? response({ id: 'dep-2', status: 'live' })
      : response({ service: { serviceDetails: { url: 'https://demo.onrender.com' } } }),
  });
  assert.equal(current.status, 'live');
  assert.equal(current.providerUrl, 'https://demo.onrender.com');
  const rollback = await rollbackRenderDeployment({ apiKey: 'x', serviceId: 'srv-1', deploymentId: 'dep-old' }, {
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).deployId, 'dep-old');
      return response({ id: 'dep-3', status: 'created' }, 201);
    },
  });
  assert.equal(rollback.deploymentId, 'dep-3');
});

test('creates a DigitalOcean App Platform app and starts its first deployment', async () => {
  const calls = [];
  const result = await createDigitalOceanDeployment({
    accessToken: 'do-token', region: 'nyc', repositoryUrl: 'https://github.com/acme/private-demo',
    branch: 'main', commitSha: 'c'.repeat(40), projectName: 'Demo App', profile: { runtime: 'node' }, env: { NODE_ENV: 'production' },
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/apps')) return response({ app: { id: 'app-1', live_url: 'https://demo.ondigitalocean.app' } }, 201);
    return response({ deployment: { id: 'do-dep-1', phase: 'PENDING' } }, 201);
  } });
  assert.equal(calls.length, 2);
  const spec = JSON.parse(calls[0].options.body).spec;
  assert.equal(spec.services[0].github.repo, 'acme/private-demo');
  assert.equal(spec.services[0].github.deploy_on_push, false);
  assert.equal(spec.services[0].envs[0].key, 'NODE_ENV');
  assert.equal(spec.services[0].envs[0].type, 'SECRET');
  assert.equal(result.projectId, 'app-1');
  assert.equal(result.deploymentId, 'do-dep-1');
  assert.equal(result.status, 'queued');
});

test('clears deleted DigitalOcean App Platform secrets when the Kestrel environment is empty', async () => {
  let submittedSpec;
  const result = await deployDigitalOceanApp({
    accessToken: 'do-token', appId: 'app-1', commitSha: 'f'.repeat(40), env: {},
  }, {
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response({ app: {
        id: 'app-1',
        spec: {
          services: [{ name: 'api', envs: [{ key: 'OLD_SERVICE_SECRET', value: 'old', type: 'SECRET' }] }],
          static_sites: [{ name: 'web', envs: [{ key: 'OLD_BUILD_SECRET', value: 'old', type: 'SECRET' }] }],
          workers: [{ name: 'worker', envs: [{ key: 'OLD_WORKER_SECRET', value: 'old', type: 'SECRET' }] }],
        },
      } });
      submittedSpec = JSON.parse(options.body).spec;
      return response({ app: { id: 'app-1', in_progress_deployment: {
        id: 'do-empty-env', phase: 'PENDING', services: [{ source_commit_hash: 'f'.repeat(40) }],
      } } });
    },
  });
  assert.deepEqual(submittedSpec.services[0].envs, []);
  assert.deepEqual(submittedSpec.static_sites[0].envs, []);
  assert.deepEqual(submittedSpec.workers[0].envs, []);
  assert.equal(result.deploymentId, 'do-empty-env');
});

test('deploys, polls and rolls back a DigitalOcean app', async () => {
  const deployed = await deployDigitalOceanApp({ accessToken: 'x', appId: 'app-1', commitSha: 'd'.repeat(40), env: { API_KEY: 'secret' } }, {
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') return response({ app: { id: 'app-1', spec: { services: [{ name: 'api', envs: [] }] } } });
      assert.equal(options.method, 'PUT');
      const spec = JSON.parse(options.body).spec;
      assert.equal(spec.services[0].envs[0].key, 'API_KEY');
      return response({ app: { id: 'app-1', in_progress_deployment: { id: 'do-dep-2', phase: 'PENDING', services: [{ source_commit_hash: 'd'.repeat(40) }] } } }, 200);
    },
  });
  assert.equal(deployed.deploymentId, 'do-dep-2');
  assert.equal(deployed.status, 'queued');
  const current = await getDigitalOceanDeployment({ accessToken: 'x', appId: 'app-1', deploymentId: 'do-dep-2' }, {
    fetchImpl: async (url) => url.endsWith('/apps/app-1')
      ? response({ app: { id: 'app-1', live_url: 'https://demo.ondigitalocean.app' } })
      : response({ deployment: { id: 'do-dep-2', phase: 'ACTIVE' } }),
  });
  assert.equal(current.status, 'live');
  assert.equal(current.providerUrl, 'https://demo.ondigitalocean.app');
  const rollback = await rollbackDigitalOceanDeployment({ accessToken: 'x', appId: 'app-1', deploymentId: 'do-old' }, {
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).deployment_id, 'do-old');
      return response({ deployment: { id: 'do-dep-3', phase: 'PENDING' } }, 201);
    },
  });
  assert.equal(rollback.deploymentId, 'do-dep-3');
});

test('uses detected framework output directories and custom build commands on DigitalOcean', async () => {
  const cases = [
    { outputDirectory: 'public', buildCommand: 'npm run build:docs' },
    { outputDirectory: 'build', buildCommand: 'npm ci && npm run build' },
    { outputDirectory: 'dist/site/browser', buildCommand: 'npm run build:production' },
  ];
  for (const [index, config] of cases.entries()) {
    let spec;
    await createDigitalOceanDeployment({
      accessToken: 'do-token', repositoryUrl: 'https://github.com/acme/private-demo',
      commitSha: String(index + 1).repeat(40), projectName: 'Static Demo',
      profile: { runtime: 'node', isStatic: true, outputDirectory: config.outputDirectory },
      buildCommand: config.buildCommand,
    }, {
      fetchImpl: async (url, options) => {
        if (url.endsWith('/apps')) {
          spec = JSON.parse(options.body).spec;
          return response({ app: { id: `app-${index}` } }, 201);
        }
        return response({ deployment: { id: `dep-${index}`, phase: 'PENDING' } }, 201);
      },
    });
    assert.equal(spec.static_sites[0].output_dir, config.outputDirectory);
    assert.equal(spec.static_sites[0].build_command, config.buildCommand);
  }
});

test('rejects unsafe DigitalOcean static output directories before creating an app', async () => {
  await assert.rejects(createDigitalOceanDeployment({
    accessToken: 'do-token', repositoryUrl: 'https://github.com/acme/private-demo',
    commitSha: 'a'.repeat(40), profile: { isStatic: true, outputDirectory: '../outside' },
  }, { fetchImpl: async () => assert.fail('DigitalOcean API must not be called') }), /Invalid DigitalOcean static output directory/);
});

test('rejects malformed GitHub URLs and invalid commit SHAs before calling providers', async () => {
  const noNetwork = async () => assert.fail('Provider API must not be called');
  await assert.rejects(createRenderDeployment({
    apiKey: 'x', ownerId: 'owner-123', repositoryUrl: 'https://gitlab.com/acme/demo', commitSha: 'a'.repeat(40),
  }, { fetchImpl: noNetwork }), /GitHub repository/);
  await assert.rejects(createDigitalOceanDeployment({
    accessToken: 'x', repositoryUrl: 'https://github.com/acme/private-demo', commitSha: 'bad',
  }, { fetchImpl: noNetwork }), /verified Git commit SHA/);
});


test('creates a Render Docker service using the configured monorepo root and Docker context', async () => {
  const calls = [];
  const result = await createRenderDeployment({
    apiKey: 'render-token',
    ownerId: 'owner-123',
    repositoryUrl: 'https://github.com/acme/monorepo',
    branch: 'main',
    commitSha: 'e'.repeat(40),
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
      if (url.endsWith('/services')) return response({
        service: { id: 'srv-docker', serviceDetails: { url: 'https://api.onrender.com' } },
      }, 201);
      if (url.endsWith('/services/srv-docker/env-vars')) {
        assert.equal(options.method, 'PUT');
        assert.deepEqual(JSON.parse(options.body), []);
        return response([]);
      }
      return response({ id: 'dep-docker', status: 'created' }, 201);
    },
  });
  assert.equal(calls.length, 3);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.rootDir, 'apps/api');
  assert.equal(body.serviceDetails.runtime, 'docker');
  assert.deepEqual(body.serviceDetails.envSpecificDetails, {
    dockerfilePath: './Dockerfile',
    dockerContext: '.',
  });
  assert.equal(body.serviceDetails.buildCommand, undefined);
  assert.equal(body.serviceDetails.startCommand, undefined);
  assert.equal(result.serviceId, 'srv-docker');
  assert.equal(result.deploymentId, 'dep-docker');
});


test('sends an empty Render environment set to remove deleted Kestrel secrets', async () => {
  const calls = [];
  const result = await deployRenderService({
    apiKey: 'render-token',
    serviceId: 'srv-empty-env',
    commitSha: 'f'.repeat(40),
    env: {},
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/env-vars')) {
        assert.equal(options.method, 'PUT');
        assert.deepEqual(JSON.parse(options.body), []);
        return response([]);
      }
      assert.equal(url.endsWith('/deploys'), true);
      return response({ id: 'dep-empty-env', status: 'created' }, 201);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.deploymentId, 'dep-empty-env');
});
