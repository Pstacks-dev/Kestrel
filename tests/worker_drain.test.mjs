import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrainController } from '../worker/drain-controller.mjs';

test('starts a bounded drain timeout only while executions are active', () => {
  let timerCallback;
  let scheduled = 0;
  let cleared = 0;
  const controller = createDrainController({
    activeJobs: new Map(),
    isManagedImageBuildActive: () => false,
    setTimeoutImpl: (callback) => { scheduled += 1; timerCallback = callback; return { unref() {} }; },
    clearTimeoutImpl: () => { cleared += 1; },
  });
  assert.equal(controller.begin('SIGTERM'), true);
  assert.equal(scheduled, 0);
  controller.complete();
  assert.equal(cleared, 0);
  assert.equal(timerCallback, undefined);
});

test('aborts local and Docker jobs and forces exit only after the drain timeout', () => {
  let timerCallback;
  const calls = [];
  const abortController = new AbortController();
  const child = { kill: (signal) => calls.push(['kill', signal]) };
  const jobs = new Map([
    ['local-job', { abortController, child }],
    ['docker-job', { containerName: 'kestrel-job-2' }],
  ]);
  const controller = createDrainController({
    activeJobs: jobs,
    setTimeoutImpl: (callback, delay) => {
      calls.push(['timeout', delay]);
      timerCallback = callback;
      return { unref() {} };
    },
    stopContainer: (name) => calls.push(['stop', name]),
    forceExit: (signal) => calls.push(['exit', signal]),
    logger: { warn() {} },
  });
  assert.equal(controller.begin('SIGTERM'), true);
  assert.equal(controller.begin('SIGINT'), false);
  assert.equal(calls.filter(([name]) => name === 'timeout').length, 1);
  assert.equal(abortController.signal.aborted, false);
  timerCallback();
  assert.equal(abortController.signal.aborted, true);
  assert.ok(calls.some(([name, value]) => name === 'kill' && value === 'SIGTERM'));
  assert.ok(calls.some(([name, value]) => name === 'stop' && value === 'kestrel-job-2'));
  assert.ok(calls.some(([name, value]) => name === 'exit' && value === 'SIGTERM'));
});

test('waits for a managed image build even when no ordinary job is active', () => {
  let timerCallback;
  const calls = [];
  const controller = createDrainController({
    activeJobs: new Map(),
    isManagedImageBuildActive: () => true,
    setTimeoutImpl: (callback) => { timerCallback = callback; return { unref() {} }; },
    forceExit: (signal) => calls.push(signal),
    logger: { warn() {} },
  });
  assert.equal(controller.begin('SIGTERM'), true);
  assert.equal(typeof timerCallback, 'function');
  timerCallback();
  assert.deepEqual(calls, ['SIGTERM']);
});

test('clears the force-exit timer after all executions drain normally', () => {
  let cleared = 0;
  const controller = createDrainController({
    activeJobs: new Map([['job', { containerName: 'kestrel-job-1' }]]),
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => { cleared += 1; },
  });
  controller.begin('SIGTERM');
  controller.complete();
  assert.equal(cleared, 1);
});
