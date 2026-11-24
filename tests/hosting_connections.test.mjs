import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProviderCredentials } from '../server/routes/hosting-connections.mjs';

test('validates required credential shapes for the six initial full-stack providers', () => {
  assert.equal(validateProviderCredentials('render', { apiKey: 'render-secret' }), true);
  assert.equal(validateProviderCredentials('railway', { token: 'railway-secret' }), true);
  assert.equal(validateProviderCredentials('flyio', { token: 'fly-secret' }), true);
  assert.equal(validateProviderCredentials('aws-app-runner', { accessKeyId: 'key', secretAccessKey: 'secret', region: 'us-east-1' }), true);
  assert.equal(validateProviderCredentials('digitalocean-app-platform', { accessToken: 'do-token' }), true);
  assert.equal(validateProviderCredentials('heroku', { apiKey: 'heroku-token' }), true);
});

test('requires a valid Google service account document', () => {
  assert.equal(validateProviderCredentials('google-cloud-run', { projectId: 'demo', serviceAccountJson: '{"type":"service_account","client_email":"x@example.com","private_key":"key"}' }), true);
  assert.equal(validateProviderCredentials('google-cloud-run', { projectId: 'demo', serviceAccountJson: '{}' }), false);
  assert.equal(validateProviderCredentials('google-cloud-run', { projectId: 'demo', serviceAccountJson: 'not-json' }), false);
});

test('rejects missing credentials, unsupported providers and extra secret fields', () => {
  assert.equal(validateProviderCredentials('render', {}), false);
  assert.equal(validateProviderCredentials('unknown', { token: 'x' }), false);
  assert.equal(validateProviderCredentials('railway', { token: 'x', password: 'not-allowed' }), false);
  assert.equal(validateProviderCredentials('cloudflare-pages', { apiToken: 'token' }), false);
});
