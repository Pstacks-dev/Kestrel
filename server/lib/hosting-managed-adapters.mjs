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
  createFlyDeployment, deployFlyApp, getFlyDeployment, getFlyDeploymentLogs, rollbackFlyDeployment,
} from './hosting-flyio.mjs';
import {
  createCloudRunDeployment, deployCloudRunService, getCloudRunDeployment, getCloudRunDeploymentLogs, rollbackCloudRunDeployment,
} from './hosting-cloud-run.mjs';
import {
  createEcsExpressDeployment, updateEcsExpressDeployment, getEcsExpressDeployment, getEcsExpressDeploymentLogs, rollbackEcsExpressDeployment,
} from './hosting-aws-ecs-express.mjs';
import {
  createNetlifyDeployment, deployNetlifySite, getNetlifyDeployment, getNetlifyDeploymentLogs, rollbackNetlifyDeployment,
} from './hosting-netlify.mjs';
import {
  createCloudflarePagesDeployment, deployCloudflarePagesProject, getCloudflarePagesDeployment, getCloudflarePagesDeploymentLogs, rollbackCloudflarePagesDeployment,
} from './hosting-cloudflare-pages.mjs';
import {
  createRailwayDeployment, deployRailwayService, getRailwayDeployment, getRailwayDeploymentLogs, rollbackRailwayDeployment,
} from './hosting-railway.mjs';

export const ACTIVE_MANAGED_PROVIDERS = ['render', 'railway', 'digitalocean-app-platform', 'vercel', 'heroku', 'netlify', 'cloudflare-pages', 'flyio', 'google-cloud-run', 'aws-ecs-express'];
export const AUTOMATIC_MANAGED_PROVIDERS = Object.freeze(ACTIVE_MANAGED_PROVIDERS.filter((provider) => provider !== 'heroku'));

export async function createManagedProviderDeployment(provider, credentials, input, options) {
  if (provider === 'render') return createRenderDeployment({ ...input, ...credentials }, options);
  if (provider === 'railway') return createRailwayDeployment({ ...input, ...credentials }, options);
  if (provider === 'digitalocean-app-platform') return createDigitalOceanDeployment({ ...input, ...credentials }, options);
  if (provider === 'vercel') return createVercelDeployment({ ...input, ...credentials }, options);
  if (provider === 'heroku') return createHerokuDeployment({ ...input, ...credentials }, options);
  if (provider === 'flyio') return createFlyDeployment({ ...input, ...credentials }, options);
  if (provider === 'google-cloud-run') return createCloudRunDeployment({ ...input, ...credentials }, options);
  if (provider === 'aws-ecs-express') return createEcsExpressDeployment({ ...input, ...credentials }, options);
  if (provider === 'netlify') return createNetlifyDeployment({ ...input, ...credentials }, options);
  if (provider === 'cloudflare-pages') return createCloudflarePagesDeployment({ ...input, ...credentials }, options);
  throw new Error('Managed deployment adapter is not available');
}

export async function deployManagedProviderService(provider, credentials, resource, commitSha, options, context = {}) {
  if (provider === 'render') return deployRenderService({ ...credentials, ...context, serviceId: resource.provider_service_id, commitSha, env: context.env || {} }, options);
  if (provider === 'railway') return deployRailwayService({ ...credentials, projectId: resource.provider_project_id, serviceId: resource.provider_service_id, environmentId: resource.provider_environment_id, commitSha, env: context.env || {}, profile: context.profile || {} }, options);
  if (provider === 'digitalocean-app-platform') return deployDigitalOceanApp({ ...credentials, ...context, appId: resource.provider_project_id, commitSha, env: context.env || {} }, options);
  if (provider === 'vercel') return deployVercelProject({ ...credentials, projectId: resource.provider_project_id, projectName: resource.provider_service_id, commitSha, ...context }, options);
  if (provider === 'heroku') return deployHerokuApp({ ...credentials, appId: resource.provider_project_id, commitSha, dynoSize: resource.metadata?.herokuDynoSize || 'basic', dynoQuantity: Number(resource.metadata?.herokuDynoQuantity || 1), ...context }, options);
  if (provider === 'flyio') return deployFlyApp({ ...credentials, appName: resource.provider_project_id, commitSha, ...context }, options);
  if (provider === 'google-cloud-run') return deployCloudRunService({ ...credentials, projectId: resource.provider_project_id, serviceName: resource.provider_service_id, region: resource.provider_environment_id, commitSha, ...context }, options);
  if (provider === 'aws-ecs-express') return updateEcsExpressDeployment({ ...credentials, serviceArn: resource.provider_project_id, ...context }, options);
  if (provider === 'netlify') return deployNetlifySite({ ...credentials, siteId: resource.provider_project_id, commitSha, ...context }, options);
  if (provider === 'cloudflare-pages') return deployCloudflarePagesProject({ ...credentials, accountId: resource.provider_project_id, projectName: resource.provider_service_id, commitSha, ...context }, options);
  throw new Error('Managed deployment adapter is not available');
}

export async function getManagedProviderDeployment(provider, credentials, resource, deploymentId, options) {
  if (provider === 'render') return getRenderDeployment({ ...credentials, serviceId: resource.provider_service_id, deploymentId }, options);
  if (provider === 'railway') return getRailwayDeployment({ ...credentials, deploymentId }, options);
  if (provider === 'digitalocean-app-platform') return getDigitalOceanDeployment({ ...credentials, appId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'vercel') return getVercelDeployment({ ...credentials, deploymentId }, options);
  if (provider === 'heroku') return getHerokuDeployment({ ...credentials, appId: resource.provider_project_id, deploymentId, dynoSize: resource.metadata?.herokuDynoSize || 'basic', dynoQuantity: Number(resource.metadata?.herokuDynoQuantity || 1) }, options);
  if (provider === 'flyio') return getFlyDeployment({ ...credentials, appName: resource.provider_project_id, deploymentId }, options);
  if (provider === 'google-cloud-run') return getCloudRunDeployment({ ...credentials, projectId: resource.provider_project_id, serviceName: resource.provider_service_id, region: resource.provider_environment_id, deploymentId }, options);
  if (provider === 'aws-ecs-express') return getEcsExpressDeployment({ ...credentials, serviceArn: resource.provider_project_id, deploymentId }, options);
  if (provider === 'netlify') return getNetlifyDeployment({ ...credentials, deploymentId }, options);
  if (provider === 'cloudflare-pages') return getCloudflarePagesDeployment({ ...credentials, accountId: resource.provider_project_id, projectName: resource.provider_service_id, deploymentId }, options);
  throw new Error('Managed deployment adapter is not available');
}

export async function getManagedProviderDeploymentLogs(provider, credentials, resource, deploymentId, options) {
  if (provider === 'render') return getRenderDeploymentLogs({ ...credentials, ownerId: resource.provider_project_id, serviceId: resource.provider_service_id, deploymentId }, options);
  if (provider === 'railway') return getRailwayDeploymentLogs({ ...credentials, deploymentId }, options);
  if (provider === 'digitalocean-app-platform') return getDigitalOceanDeploymentLogs({ ...credentials, appId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'vercel') return getVercelDeploymentLogs({ ...credentials, deploymentId }, options);
  if (provider === 'heroku') return getHerokuDeploymentLogs({ ...credentials, appId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'flyio') return getFlyDeploymentLogs({ ...credentials, appName: resource.provider_project_id, deploymentId }, options);
  if (provider === 'google-cloud-run') return getCloudRunDeploymentLogs({ ...credentials, projectId: resource.provider_project_id, serviceName: resource.provider_service_id, region: resource.provider_environment_id, deploymentId }, options);
  if (provider === 'aws-ecs-express') return getEcsExpressDeploymentLogs({ ...credentials, serviceArn: resource.provider_project_id }, options);
  if (provider === 'netlify') return getNetlifyDeploymentLogs({ ...credentials, deploymentId }, options);
  if (provider === 'cloudflare-pages') return getCloudflarePagesDeploymentLogs({ ...credentials, accountId: resource.provider_project_id, projectName: resource.provider_service_id, deploymentId }, options);
  throw new Error('Managed deployment adapter is not available');
}

export async function rollbackManagedProviderDeployment(provider, credentials, resource, deploymentId, options) {
  if (provider === 'render') return rollbackRenderDeployment({ ...credentials, serviceId: resource.provider_service_id, deploymentId }, options);
  if (provider === 'railway') return rollbackRailwayDeployment({ ...credentials, deploymentId }, options);
  if (provider === 'digitalocean-app-platform') return rollbackDigitalOceanDeployment({ ...credentials, appId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'vercel') return rollbackVercelDeployment({ ...credentials, projectId: resource.provider_project_id, projectName: resource.provider_service_id, deploymentId }, options);
  if (provider === 'heroku') return rollbackHerokuDeployment({ ...credentials, appId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'flyio') return rollbackFlyDeployment({ ...credentials, appName: resource.provider_project_id, deploymentId }, options);
  if (provider === 'google-cloud-run') return rollbackCloudRunDeployment({ ...credentials, projectId: resource.provider_project_id, serviceName: resource.provider_service_id, region: resource.provider_environment_id, deploymentId }, options);
  if (provider === 'aws-ecs-express') return rollbackEcsExpressDeployment({ ...credentials, serviceArn: resource.provider_project_id, deploymentId }, options);
  if (provider === 'netlify') return rollbackNetlifyDeployment({ ...credentials, siteId: resource.provider_project_id, deploymentId }, options);
  if (provider === 'cloudflare-pages') return rollbackCloudflarePagesDeployment({ ...credentials, accountId: resource.provider_project_id, projectName: resource.provider_service_id, deploymentId }, options);
  throw new Error('Managed deployment adapter is not available');
}
