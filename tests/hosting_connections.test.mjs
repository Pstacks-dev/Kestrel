import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProviderCredentials } from '../server/routes/hosting-connections.mjs';

test('validates required credential shapes for connected hosting providers', () => {
  assert.equal(validateProviderCredentials('render', { apiKey: 'render-secret', ownerId: 'owner-123' }), true);
  assert.equal(validateProviderCredentials('railway', { token: 'railway-secret' }), true);
  assert.equal(validateProviderCredentials('flyio', { token: 'fly-secret', orgSlug: 'personal' }), true);
  assert.equal(validateProviderCredentials('aws-ecs-express', { accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'temporary-session', region: 'us-east-1', executionRoleArn: 'arn:aws:iam::123456789012:role/ecsExecution', infrastructureRoleArn: 'arn:aws:iam::123456789012:role/ecsInfrastructure' }), true);
  assert.equal(validateProviderCredentials('digitalocean-app-platform', { accessToken: 'do-token' }), true);
  assert.equal(validateProviderCredentials('heroku', { apiKey: 'heroku-token' }), true);
  assert.equal(validateProviderCredentials('vercel', { token: 'vercel-token' }), true);
  assert.equal(validateProviderCredentials('vercel', { token: 'vercel-token', teamId: 'team-123' }), true);
  assert.equal(validateProviderCredentials('vercel', { token: 'vercel-token', teamId: 42 }), false);
  assert.equal(validateProviderCredentials('netlify', { authToken: 'netlify-token' }), true);
  assert.equal(validateProviderCredentials('cloudflare-pages', { apiToken: 'cf-token', accountId: 'a'.repeat(32) }), true);
});

test('requires a valid Google service account document', () => {
  assert.equal(validateProviderCredentials('google-cloud-run', { projectId: 'demo', serviceAccountJson: '{"type":"service_account","client_email":"x@example.com","private_key":"key"}' }), true);
  assert.equal(validateProviderCredentials('google-cloud-run', { projectId: 'demo', serviceAccountJson: '{}' }), false);
  assert.equal(validateProviderCredentials('google-cloud-run', { projectId: 'demo', serviceAccountJson: 'not-json' }), false);
});

test('rejects missing credentials, unsupported providers and extra secret fields', () => {
  assert.equal(validateProviderCredentials('render', {}), false);
  assert.equal(validateProviderCredentials('render', { apiKey: 'render-secret' }), false);
  assert.equal(validateProviderCredentials('unknown', { token: 'x' }), false);
  assert.equal(validateProviderCredentials('railway', { token: 'x', password: 'not-allowed' }), false);
  assert.equal(validateProviderCredentials('cloudflare-pages', { apiToken: 'token' }), false);
});

test('accepts optional Railway workspace-scoped token metadata', () => {
  assert.equal(validateProviderCredentials('railway', { token: 'railway-secret', workspaceId: 'workspace-123' }), true);
  assert.equal(validateProviderCredentials('railway', { token: 'railway-secret', workspaceId: 42 }), false);
});
