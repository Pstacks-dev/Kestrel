import {
  createRenderDeployment, deployRenderService, getRenderDeployment, getRenderDeploymentLogs, rollbackRenderDeployment,
} from './hosting-render.mjs';
import {
  createDigitalOceanDeployment, deployDigitalOceanApp, getDigitalOceanDeployment, getDigitalOceanDeploymentLogs, rollbackDigitalOceanDeployment,
} from './hosting-digitalocean.mjs';
import {
  createVercelDeployment, deployVercelProject, getVercelDeployment, getVercelDeploymentLogs, rollbackVercelDeployment,
} from './hosting-vercel.mjs';
import {
  createHerokuDeployment, deployHerokuApp, getHerokuDeployment, getHerokuDeploymentLogs, rollbackHerokuDeployment,
} from './hosting-heroku.mjs';
import {
  createEcsExpressDeployment, updateEcsExpressDeployment, getEcsExpressDeployment, getEcsExpressDeploymentLogs, rollbackEcsExpressDeployment,
} from './hosting-aws-ecs-express.mjs';
import {
  createRailwayDeployment, deployRailwayService, getRailwayDeployment, getRailwayDeploymentLogs, rollbackRailwayDeployment,
} from './hosting-railway.mjs';

export const ACTIVE_MANAGED_PROVIDERS = ['render', 'railway', 'digitalocean-app-platform', 'vercel'];

export async function createManagedProviderDeployment(provider, credentials, input, options) {
  if (provider === 'render') return createRenderDeployment({ ...input, ...credentials }, options);
  if (provider === 'railway') return createRailwayDeployment({ ...input, ...credentials }, options);
  if (provider === 'digitalocean-app-platform') return createDigitalOceanDeployment({ ...input, ...credentials }, options);
  if (provider === 'vercel') return createVercelDeployment({ ...input, ...credentials }, options);
  if (provider === 'heroku') return createHerokuDeployment({ ...input, ...credentials }, options);
  if (provider === 'aws-ecs-express') return createEcsExpressDeployment({ ...input, ...credentials }, options);
  throw new Error('Managed deployment adapter is not available');
}

export async function deployManagedProviderService(provider, credentials, resource, commitSha, options, context = {}) {
  if (provider === 'render') return deployRenderService({ ...credentials, serviceId: resource.provider_service_id, commitSha }, options);
  if (provider === 'railway') return deployRailwayService({ ...credentials, serviceId: resource.provider_service_id, environmentId: resource.provider_environment_id, commitSha }, options);
  if (provider === 'digitalocean-app-platform') return deployDigitalOceanApp({ ...credentials, appId: resource.provider_project_id, commitSha }, options);
  if (provider === 'vercel') return deployVercelProject({ ...credentials, projectId: resource.provider_project_id, projectName: resource.provider_service_id, commitSha, ...context }, options);
  if (provider === 'heroku') return deployHerokuApp({ ...credentials, appId: resource.provider_project_id, commitSha, ...context }, options);
  if (provider === 'aws-ecs-express') return updateEcsExpressDeployment({ ...credentials, serviceArn: resource.provider_project_id, ...context }, options);
  throw new Error('Managed deployment adapter is not available');
}

export async function getManagedProviderDeployment(provider, credentials, resource, deploymentId, options) {
  if (provider === 'render') return getRenderDeployment({ ...credentials, serviceId: resource.provider_service_id, deploymentId }, options);
  if (provider === 'railway') return getRailwayDeployment({ ...credentials, deploymentId }, options);
  if (provider === 'digitalocean-app-platform') return getDigitalOceanDeployment({ ...credentials, appId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'vercel') return getVercelDeployment({ ...credentials, deploymentId }, options);
  if (provider === 'heroku') return getHerokuDeployment({ ...credentials, appId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'aws-ecs-express') return getEcsExpressDeployment({ ...credentials, serviceArn: resource.provider_project_id, deploymentId }, options);
  throw new Error('Managed deployment adapter is not available');
}

export async function getManagedProviderDeploymentLogs(provider, credentials, resource, deploymentId, options) {
  if (provider === 'render') return getRenderDeploymentLogs({ ...credentials, serviceId: resource.provider_service_id, deploymentId }, options);
  if (provider === 'railway') return getRailwayDeploymentLogs({ ...credentials, deploymentId }, options);
  if (provider === 'digitalocean-app-platform') return getDigitalOceanDeploymentLogs({ ...credentials, appId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'vercel') return getVercelDeploymentLogs({ ...credentials, deploymentId }, options);
  if (provider === 'heroku') return getHerokuDeploymentLogs({ ...credentials, appId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'aws-ecs-express') return getEcsExpressDeploymentLogs({ ...credentials, serviceArn: resource.provider_project_id }, options);
  throw new Error('Managed deployment adapter is not available');
}

export async function rollbackManagedProviderDeployment(provider, credentials, resource, deploymentId, options) {
  if (provider === 'render') return rollbackRenderDeployment({ ...credentials, serviceId: resource.provider_service_id, deploymentId }, options);
  if (provider === 'railway') return rollbackRailwayDeployment({ ...credentials, deploymentId }, options);
  if (provider === 'digitalocean-app-platform') return rollbackDigitalOceanDeployment({ ...credentials, appId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'vercel') return rollbackVercelDeployment({ ...credentials, projectId: resource.provider_project_id, projectName: resource.provider_service_id, deploymentId }, options);
  if (provider === 'heroku') return rollbackHerokuDeployment({ ...credentials, appId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'aws-ecs-express') return rollbackEcsExpressDeployment({ ...credentials, serviceArn: resource.provider_project_id, deploymentId }, options);
  throw new Error('Managed deployment adapter is not available');
}
