import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createCloudRunDeployment, deployCloudRunService, getCloudRunDeployment,
  getCloudRunDeploymentLogs, rollbackCloudRunDeployment,
} from '../server/lib/hosting-cloud-run.mjs';

const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});

function serviceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return JSON.stringify({
    type: 'service_account', project_id: 'project-1',
    client_email: 'kestrel@project-1.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
}

function mockGoogle() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === 'https://oauth2.googleapis.com/token') return response({ access_token: 'google-access-token' });
    if (url.includes('/services?serviceId=')) {
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.equal(body.template.containers[0].image, 'us-docker.pkg.dev/project-1/apps/demo:abc123');
      assert.equal(body.template.containers[0].ports[0].containerPort, 8080);
      assert.equal(body.template.containers[0].env[0].name, 'NODE_ENV');
      return response({ name: 'projects/project-1/locations/us-central1/operations/op-1' }, 200);
    }
    if (url.includes('/services/demo?updateMask=traffic')) return response({ name: 'projects/project-1/locations/us-central1/operations/rollback-1' });
    if (url.includes('/services/demo?updateMask=')) return response({ name: 'projects/project-1/locations/us-central1/operations/op-2' });
    if (url.includes('/operations/op-1')) return response({ name: 'projects/project-1/locations/us-central1/operations/op-1', done: true });
    if (url.includes('/services/demo')) return response({
      uri: 'https://demo-123.a.run.app',
      latestCreatedRevision: 'projects/project-1/locations/us-central1/services/demo/revisions/demo-00002-abcd1234',
      latestReadyRevision: 'projects/project-1/locations/us-central1/services/demo/revisions/demo-00002-abcd1234',
      conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
    });
    if (url.includes('/entries:list')) return response({ entries: [{ timestamp: '2026-11-24T10:00:00Z', textPayload: 'service started' }] });
    if (url.includes('?updateMask=traffic')) {
      const body = JSON.parse(options.body);
      assert.equal(body.traffic[0].revision, 'demo-00002-abcd1234');
      assert.equal(body.traffic[0].percent, 100);
      return response({ name: 'projects/project-1/locations/us-central1/operations/rollback-1' });
    }
    throw new Error(`Unexpected Google API request: ${url}`);
  };
  return { calls, fetchImpl };
}

test('creates a Cloud Run service from a published OCI image', async () => {
  const { calls, fetchImpl } = mockGoogle();
  const result = await createCloudRunDeployment({
    serviceAccountJson: serviceAccount(), projectId: 'project-1', region: 'us-central1',
    projectName: 'Kestrel Demo', containerImage: 'us-docker.pkg.dev/project-1/apps/demo:abc123',
    port: 8080, env: { NODE_ENV: 'production' }, maxInstances: 4,
  }, { fetchImpl });
  assert.equal(result.projectId, 'project-1');
  assert.equal(result.serviceId, 'kestrel-demo');
  assert.equal(result.deploymentId, 'projects/project-1/locations/us-central1/operations/op-1');
  assert.equal(calls.length, 2);
});

test('updates an existing Cloud Run service for a later image', async () => {
  const { fetchImpl } = mockGoogle();
  const result = await deployCloudRunService({
    serviceAccountJson: serviceAccount(), projectId: 'project-1', serviceName: 'demo',
    containerImage: 'us-docker.pkg.dev/project-1/apps/demo:next',
  }, { fetchImpl });
  assert.match(result.deploymentId, /operations\/op-2$/);
});

test('polls the long-running operation and resolves the live revision URL', async () => {
  const { fetchImpl } = mockGoogle();
  const result = await getCloudRunDeployment({
    serviceAccountJson: serviceAccount(), projectId: 'project-1', serviceName: 'demo',
    deploymentId: 'projects/project-1/locations/us-central1/operations/op-1',
  }, { fetchImpl });
  assert.equal(result.status, 'live');
  assert.equal(result.providerUrl, 'https://demo-123.a.run.app');
  assert.match(result.providerDeploymentId, /revisions\/demo-00002-abcd1234$/);
});

test('retrieves Cloud Run runtime logs from Cloud Logging', async () => {
  const { fetchImpl } = mockGoogle();
  const logs = await getCloudRunDeploymentLogs({
    serviceAccountJson: serviceAccount(), projectId: 'project-1', serviceName: 'demo',
    deploymentId: 'projects/project-1/locations/us-central1/services/demo/revisions/demo-00002-abcd1234',
  }, { fetchImpl });
  assert.equal(logs.runtime[0].message, 'service started');
  assert.equal(logs.unavailable, false);
});

test('rolls back Cloud Run traffic to a previous ready revision', async () => {
  const { fetchImpl } = mockGoogle();
  const result = await rollbackCloudRunDeployment({
    serviceAccountJson: serviceAccount(), projectId: 'project-1', serviceName: 'demo',
    deploymentId: 'projects/project-1/locations/us-central1/services/demo/revisions/demo-00002-abcd1234',
  }, { fetchImpl });
  assert.match(result.deploymentId, /operations\/rollback-1$/);
});

test('rejects invalid OCI image references before calling Cloud Run', async () => {
  await assert.rejects(createCloudRunDeployment({
    serviceAccountJson: serviceAccount(), projectId: 'project-1',
    projectName: 'demo', containerImage: 'not-a-container-image',
  }, { fetchImpl: async () => assert.fail('Google APIs must not be called') }), /published OCI image/);
});
