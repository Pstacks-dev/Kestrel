import crypto from 'node:crypto';

function signingKey(secret, date, region, service) {
  const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

async function awsRequest(credentials, service, action, payload, { fetchImpl = fetch } = {}) {
  const region = credentials.region;
  const host = `${service}.${region}.amazonaws.com`;
  const body = JSON.stringify(payload || {});
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const contentType = 'application/x-amz-json-1.1';
  const target = `${service === 'logs' ? 'Logs_20140328' : 'AmazonEC2ContainerServiceV20141113'}.${action}`;
  const headers = {
    'content-type': contentType, host, 'x-amz-date': amzDate, 'x-amz-target': target,
  };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join('');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(credentials.secretAccessKey, date, region, service)).update(stringToSign).digest('hex');
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetchImpl(`https://${host}/`, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(30000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`AWS ${service} ${action} failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function imageRef(value) {
  if (typeof value !== 'string' || value.length > 512 ||
      !/^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9._/-]+(?::[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})$/i.test(value)) {
    throw new Error('A published OCI image reference is required for ECS Express Mode');
  }
  return value;
}

function serviceName(value) {
  const name = String(value || 'kestrel-app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 255);
  return name.length >= 1 ? name : 'kestrel-app';
}

function container({ image, port, env }) {
  const containerPort = Number(port || 8080);
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) throw new Error('Application port must be between 1 and 65535');
  const environment = Object.entries(env || {}).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name) || typeof value !== 'string' || value.length > 30000) throw new Error('Invalid ECS Express environment variable');
    return { name, value };
  });
  if (environment.length > 100) throw new Error('ECS Express container supports at most 100 environment variables');
  return { image, containerPort, ...(environment.length ? { environment } : {}) };
}

function revisionId(service) {
  return service.activeConfigurations?.find((item) => item.serviceRevisionArn)?.serviceRevisionArn ||
    service.currentDeployment ||
    service.targetConfiguration?.serviceRevisionArn || service.serviceArn;
}

function endpoint(service) {
  const entries = service.activeConfigurations || [];
  const paths = entries.flatMap((item) => item.ingressPaths || []);
  const first = paths.find((item) => item.endpoint);
  return first?.endpoint || service.ingressPaths?.find((item) => item.endpoint)?.endpoint || null;
}

export async function createEcsExpressDeployment({ accessKeyId, secretAccessKey, sessionToken, region, executionRoleArn, infrastructureRoleArn, projectName, containerImage, port, env, healthCheckPath = '/', cpu = '1024', memory = '2048', minTaskCount = 1, maxTaskCount = 3 }, { fetchImpl = fetch } = {}) {
  const image = imageRef(containerImage);
  const service = await awsRequest({ accessKeyId, secretAccessKey, sessionToken, region }, 'ecs', 'CreateExpressGatewayService', {
    serviceName: serviceName(projectName), executionRoleArn, infrastructureRoleArn,
    primaryContainer: container({ image, port, env }),
    healthCheckPath,
    cpu: String(cpu), memory: String(memory),
    scalingTarget: { minTaskCount: Number(minTaskCount), maxTaskCount: Number(maxTaskCount) },
  }, { fetchImpl });
  const value = service.service || service;
  if (!value.serviceArn) throw new Error('AWS ECS did not return an Express service ARN');
  return {
    provider: 'aws-ecs-express', projectId: value.serviceArn, serviceId: value.serviceName || serviceName(projectName),
    environmentId: region, deploymentId: revisionId(value), status: value.status?.statusCode === 'ACTIVE' ? 'deploying' : 'queued',
    providerUrl: endpoint(value),
  };
}

export async function updateEcsExpressDeployment({ accessKeyId, secretAccessKey, sessionToken, region, serviceArn, containerImage, port, env, healthCheckPath = '/' }, { fetchImpl = fetch } = {}) {
  const image = imageRef(containerImage);
  const service = await awsRequest({ accessKeyId, secretAccessKey, sessionToken, region }, 'ecs', 'UpdateExpressGatewayService', {
    serviceArn, primaryContainer: container({ image, port, env }), healthCheckPath,
  }, { fetchImpl });
  const value = service.service || service;
  return { provider: 'aws-ecs-express', deploymentId: revisionId(value), status: 'deploying', providerUrl: endpoint(value) };
}

export async function getEcsExpressDeployment({ accessKeyId, secretAccessKey, sessionToken, region, serviceArn, deploymentId }, { fetchImpl = fetch } = {}) {
  const result = await awsRequest({ accessKeyId, secretAccessKey, sessionToken, region }, 'ecs', 'DescribeExpressGatewayService', { serviceArn }, { fetchImpl });
  const service = result.service || result;
  const status = service.status?.statusCode;
  const current = revisionId(service);
  const ready = status === 'ACTIVE' && (!deploymentId || current === deploymentId);
  return {
    provider: 'aws-ecs-express', deploymentId: current, providerDeploymentId: current,
    providerStatus: status || 'UNKNOWN',
    status: ready ? 'live' : status === 'INACTIVE' ? 'failed' : 'deploying',
    providerUrl: endpoint(service),
    canRollback: Boolean(current),
  };
}

export async function getEcsExpressDeploymentLogs({ accessKeyId, secretAccessKey, sessionToken, region, serviceArn }, { fetchImpl = fetch } = {}) {
  const result = await awsRequest({ accessKeyId, secretAccessKey, sessionToken, region }, 'ecs', 'DescribeExpressGatewayService', { serviceArn }, { fetchImpl });
  const service = result.service || result;
  const primary = service.activeConfigurations?.find((item) => item.serviceRevisionArn)?.primaryContainer;
  const config = primary?.awsLogsConfiguration;
  if (!config?.logGroup) return { build: [], runtime: [], unavailable: true, message: 'ECS Express has not exposed a CloudWatch log group for this service revision.' };
  const logs = await awsRequest({ accessKeyId, secretAccessKey, sessionToken, region }, 'logs', 'FilterLogEvents', {
    logGroupName: config.logGroup,
    ...(config.logStreamPrefix ? { logStreamNamePrefix: config.logStreamPrefix } : {}),
    limit: 100,
    interleaved: true,
  }, { fetchImpl });
  return {
    build: [],
    runtime: (logs.events || []).map((event) => ({ timestamp: event.timestamp || null, message: event.message || '' })),
    unavailable: false,
  };
}

export async function rollbackEcsExpressDeployment({ accessKeyId, secretAccessKey, sessionToken, region, serviceArn, deploymentId }, { fetchImpl = fetch } = {}) {
  const credentials = { accessKeyId, secretAccessKey, sessionToken, region };
  const revisionResult = await awsRequest(credentials, 'ecs', 'DescribeServiceRevisions', {
    serviceRevisionArns: [deploymentId],
  }, { fetchImpl });
  const revision = revisionResult.serviceRevisions?.find((item) => item.serviceRevisionArn === deploymentId);
  const taskDefinitionArn = revision?.taskDefinitionArn || revision?.taskDefinition;
  if (!taskDefinitionArn) throw new Error('The selected ECS service revision is no longer available for rollback');
  const taskResult = await awsRequest(credentials, 'ecs', 'DescribeTaskDefinition', {
    taskDefinition: taskDefinitionArn,
  }, { fetchImpl });
  const task = taskResult.taskDefinition;
  const priorContainer = task?.containerDefinitions?.find((item) => item.name === 'Main') || task?.containerDefinitions?.[0];
  if (!priorContainer?.image) throw new Error('The selected ECS revision has no recoverable container image');
  const primaryContainer = {
    image: priorContainer.image,
    containerPort: priorContainer.portMappings?.find((item) => item.protocol === 'tcp')?.containerPort || 8080,
    ...(priorContainer.environment?.length ? { environment: priorContainer.environment } : {}),
    ...(priorContainer.secrets?.length ? { secrets: priorContainer.secrets } : {}),
    ...(priorContainer.command?.length ? { command: priorContainer.command } : {}),
    ...(priorContainer.logConfiguration?.options?.['awslogs-group'] ? {
      awsLogsConfiguration: {
        logGroup: priorContainer.logConfiguration.options['awslogs-group'],
        logStreamPrefix: priorContainer.logConfiguration.options['awslogs-stream-prefix'] || 'ecs',
      },
    } : {}),
  };
  const updated = await awsRequest(credentials, 'ecs', 'UpdateExpressGatewayService', {
    serviceArn, primaryContainer,
    ...(revision.healthCheckPath ? { healthCheckPath: revision.healthCheckPath } : {}),
    ...(revision.cpu ? { cpu: revision.cpu } : {}),
    ...(revision.memory ? { memory: revision.memory } : {}),
  }, { fetchImpl });
  const value = updated.service || updated;
  return { provider: 'aws-ecs-express', deploymentId: revisionId(value), status: 'deploying', providerUrl: endpoint(value) };
}
