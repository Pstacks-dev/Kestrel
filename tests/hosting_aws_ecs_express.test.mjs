import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEcsExpressDeployment, updateEcsExpressDeployment, getEcsExpressDeployment,
  getEcsExpressDeploymentLogs, rollbackEcsExpressDeployment,
} from '../server/lib/hosting-aws-ecs-express.mjs';

const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/x-amz-json-1.1' },
});

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  executionRoleArn: 'arn:aws:iam::123456789012:role/ecsTaskExecutionRole',
  infrastructureRoleArn: 'arn:aws:iam::123456789012:role/ecsInfrastructureRole',
};

function service(statusCode = 'ACTIVE', current = 'arn:aws:ecs:us-east-1:123456789012:service-revision/demo/current') {
  return {
    serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/default/demo',
    serviceName: 'demo',
    status: { statusCode },
    currentDeployment: current,
    activeConfigurations: [
      {
        serviceRevisionArn: current,
        ingressPaths: [{ endpoint: 'https://demo.ecs.us-east-1.on.aws' }],
        primaryContainer: {
          image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/demo:current',
          containerPort: 8080,
          awsLogsConfiguration: { logGroup: '/ecs/express/demo', logStreamPrefix: 'ecs' },
        },
      },
      {
        serviceRevisionArn: 'arn:aws:ecs:us-east-1:123456789012:service-revision/demo/previous',
        primaryContainer: {
          image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/demo:previous',
          containerPort: 8080,
          environment: [{ name: 'NODE_ENV', value: 'production' }],
        },
      },
    ],
  };
}

test('creates ECS Express service from immutable OCI image and signs AWS request', async () => {
  const result = await createEcsExpressDeployment({
    ...credentials, projectName: 'Kestrel Demo', containerImage: '123456789012.dkr.ecr.us-east-1.amazonaws.com/demo:sha-12345678',
    port: 8080, env: { NODE_ENV: 'production' },
  }, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://ecs.us-east-1.amazonaws.com/');
    assert.match(options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
    assert.match(options.headers.Authorization, /SignedHeaders=content-type;host;x-amz-date;x-amz-target/);
    assert.equal(options.headers['x-amz-target'], 'AmazonEC2ContainerServiceV20141113.CreateExpressGatewayService');
    const body = JSON.parse(options.body);
    assert.equal(body.serviceName, 'kestrel-demo');
    assert.equal(body.primaryContainer.containerPort, 8080);
    assert.equal(body.primaryContainer.environment[0].name, 'NODE_ENV');
    assert.equal(body.scalingTarget.minTaskCount, 1);
    return response({ service: service('CREATING') }, 200);
  } });
  assert.equal(result.projectId, 'arn:aws:ecs:us-east-1:123456789012:service/default/demo');
  assert.match(result.deploymentId, /service-revision\/demo\/current$/);
  assert.equal(result.status, 'queued');
  assert.equal(result.providerUrl, 'https://demo.ecs.us-east-1.on.aws');
});

test('updates ECS Express service to a later container image', async () => {
  const result = await updateEcsExpressDeployment({
    ...credentials, serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/default/demo',
    containerImage: '123456789012.dkr.ecr.us-east-1.amazonaws.com/demo:next',
  }, { fetchImpl: async (url, options) => {
    assert.equal(options.headers['x-amz-target'], 'AmazonEC2ContainerServiceV20141113.UpdateExpressGatewayService');
    const body = JSON.parse(options.body);
    assert.equal(body.serviceArn.endsWith('/demo'), true);
    assert.match(body.primaryContainer.image, /:next$/);
    return response({ service: service('UPDATING', 'arn:aws:ecs:us-east-1:123456789012:service-revision/demo/next') });
  } });
  assert.match(result.deploymentId, /service-revision\/demo\/next$/);
});

test('polls ECS Express status and returns the provider ingress URL', async () => {
  const result = await getEcsExpressDeployment({
    ...credentials, serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/default/demo',
  }, { fetchImpl: async (url, options) => {
    assert.equal(options.headers['x-amz-target'], 'AmazonEC2ContainerServiceV20141113.DescribeExpressGatewayService');
    return response({ service: service() });
  } });
  assert.equal(result.status, 'live');
  assert.equal(result.providerUrl, 'https://demo.ecs.us-east-1.on.aws');
  assert.equal(result.canRollback, true);
});

test('retrieves runtime logs from the service CloudWatch log group', async () => {
  const calls = [];
  const logs = await getEcsExpressDeploymentLogs({
    ...credentials, serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/default/demo',
  }, { fetchImpl: async (url, options) => {
    calls.push(options.headers['x-amz-target']);
    if (options.headers['x-amz-target'].endsWith('.DescribeExpressGatewayService')) return response({ service: service() });
    assert.equal(options.headers['x-amz-target'], 'Logs_20140328.FilterLogEvents');
    assert.equal(JSON.parse(options.body).logGroupName, '/ecs/express/demo');
    return response({ events: [{ timestamp: 1000, message: 'server started' }] });
  } });
  assert.equal(calls.length, 2);
  assert.equal(logs.runtime[0].message, 'server started');
});

test('rolls back by updating the service to a retained prior revision image', async () => {
  const result = await rollbackEcsExpressDeployment({
    ...credentials, serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/default/demo',
    deploymentId: 'arn:aws:ecs:us-east-1:123456789012:service-revision/demo/previous',
  }, { fetchImpl: async (url, options) => {
    const target = options.headers['x-amz-target'];
    if (target.endsWith('.DescribeServiceRevisions')) {
      assert.equal(JSON.parse(options.body).serviceRevisionArns[0].endsWith('/previous'), true);
      return response({ serviceRevisions: [{
        serviceRevisionArn: 'arn:aws:ecs:us-east-1:123456789012:service-revision/demo/previous',
        taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/demo:2',
        healthCheckPath: '/health', cpu: '1024', memory: '2048',
      }] });
    }
    if (target.endsWith('.DescribeTaskDefinition')) return response({ taskDefinition: { containerDefinitions: [{
      name: 'Main', image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/demo:previous',
      portMappings: [{ protocol: 'tcp', containerPort: 8080 }],
      environment: [{ name: 'NODE_ENV', value: 'production' }],
    }] } });
    const body = JSON.parse(options.body);
    assert.equal(target, 'AmazonEC2ContainerServiceV20141113.UpdateExpressGatewayService');
    assert.match(body.primaryContainer.image, /:previous$/);
    assert.equal(body.primaryContainer.environment[0].name, 'NODE_ENV');
    assert.equal(body.healthCheckPath, '/health');
    return response({ service: service('UPDATING', 'arn:aws:ecs:us-east-1:123456789012:service-revision/demo/rollback') });
  } });
  assert.match(result.deploymentId, /service-revision\/demo\/rollback$/);
});

test('rejects non-image deployments before contacting AWS', async () => {
  await assert.rejects(createEcsExpressDeployment({
    ...credentials, projectName: 'demo', containerImage: 'not-an-image',
  }, { fetchImpl: async () => assert.fail('AWS must not be called') }), /published OCI image/);
});


test('creates or reuses an immutable ECR repository and returns scoped registry credentials', async () => {
  const calls = [];
  const authToken = Buffer.from('AWS:ecr-password').toString('base64');
  const result = await prepareEcsImageRegistry({
    accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', region: 'us-east-1',
    executionRoleArn: 'arn:aws:iam::123456789012:role/KestrelExecution',
    projectName: 'kestrel-demo', commitSha: 'a'.repeat(40),
  }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const target = options.headers['x-amz-target'];
    if (target.endsWith('.DescribeRepositories')) return response({ code: 'RepositoryNotFoundException' }, 400);
    if (target.endsWith('.CreateRepository')) return response({ repository: { repositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/kestrel/kestrel-demo' } });
    if (target.endsWith('.GetAuthorizationToken')) return response({ authorizationData: [{ authorizationToken: authToken, proxyEndpoint: 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com' }] });
    throw new Error(`Unexpected ECR target: ${target}`);
  } });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers['x-amz-target'], 'AmazonEC2ContainerRegistry_V20150921.DescribeRepositories');
  assert.equal(calls[1].options.headers['x-amz-target'], 'AmazonEC2ContainerRegistry_V20150921.CreateRepository');
  assert.equal(calls[2].options.headers['x-amz-target'], 'AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken');
  assert.equal(result.registryHost, '123456789012.dkr.ecr.us-east-1.amazonaws.com');
  assert.equal(result.registryUser, 'AWS');
  assert.equal(result.registryPassword, 'ecr-password');
  assert.equal(result.imageRef, `123456789012.dkr.ecr.us-east-1.amazonaws.com/kestrel/kestrel-demo:${'a'.repeat(40)}`);
});
