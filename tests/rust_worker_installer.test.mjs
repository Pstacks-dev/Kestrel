import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installerUrl = new URL('../deploy/install-rust-worker.sh', import.meta.url);
const workerUnitUrl = new URL('../deploy/kestrel-worker-egress.service', import.meta.url);
const envExampleUrl = new URL('../.env.worker.example', import.meta.url);

test('production Rust worker installer fails closed without egress protections', async () => {
  const installer = await readFile(installerUrl, 'utf8');
  const firewallInstall = installer.indexOf('systemctl enable --now kestrel-worker-egress.service');
  const workerStart = installer.indexOf('systemctl enable --now kestrel-rust-worker.service');

  assert.ok(firewallInstall >= 0, 'installer must enable the Docker egress firewall');
  assert.ok(workerStart > firewallInstall, 'worker must start only after the firewall is active');
  assert.match(installer, /Requires=docker\.service kestrel-worker-egress\.service/);
  assert.match(installer, /NODE_ENV=production/);
  assert.match(installer, /KESTREL_EGRESS_HARDENED=true/);
  assert.match(installer, /KESTREL_JOB_IMAGE=docker\.io\/library\/node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(installer, /Pstacks-dev\/Kestrel\.git/);
  assert.match(installer, /\^wrk_\[A-Za-z0-9_-\]\{8,100\}\$/);
  assert.match(installer, /WORKER_TOKEN" =~ \^\[a-f0-9\]\{64\}\$/);
});

test('manual Docker worker example pins the job image and documents network prerequisites', async () => {
  const envExample = await readFile(envExampleUrl, 'utf8');
  const workerUnit = await readFile(workerUnitUrl, 'utf8');
  assert.match(envExample, /KESTREL_JOB_IMAGE=docker\.io\/library\/node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(envExample, /KESTREL_JOB_NETWORK=none/);
  assert.match(envExample, /deploy\/kestrel-worker-egress\.service/);
  assert.match(envExample, /KESTREL_EGRESS_HARDENED=true/);
  assert.match(workerUnit, /ExecStart=\/usr\/local\/sbin\/kestrel-harden-worker-egress/);
});


test('Rust worker installer and egress firewall scripts pass Bash syntax validation', {
  skip: process.platform === 'win32',
}, () => {
  const firewallUrl = new URL('../deploy/harden-worker-egress.sh', import.meta.url);
  execFileSync('bash', ['-n', fileURLToPath(installerUrl)]);
  execFileSync('bash', ['-n', fileURLToPath(firewallUrl)]);
});
