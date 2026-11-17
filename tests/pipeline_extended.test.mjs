import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePipelineJobs } from '../server/lib/pipeline.mjs';

test('validates complex diamond DAG workflows', () => {
  // A -> (B, C) -> D
  const jobs = validatePipelineJobs([
    { id: 'checkout', command: 'git clone' },
    { id: 'lint', command: 'npm run lint', needs: ['checkout'] },
    { id: 'test', command: 'npm test', needs: ['checkout'] },
    { id: 'deploy', command: 'npm run deploy', needs: ['lint', 'test'] },
  ]);

  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs[3].needs, ['lint', 'test']);
});

test('rejects invalid job IDs containing special characters', () => {
  assert.throws(
    () => validatePipelineJobs([{ id: 'job with spaces', command: 'true' }]),
    /must contain only alphanumeric characters/
  );
  assert.throws(
    () => validatePipelineJobs([{ id: 'job/with/slashes', command: 'true' }]),
    /must contain only alphanumeric characters/
  );
});

test('enforces timeout and retry limits', () => {
  const [job] = validatePipelineJobs([
    {
      id: 'build',
      command: 'npm run build',
      timeoutSeconds: 100000, // over max
      maxRetries: 25, // over max
    },
  ]);

  assert.equal(job.timeoutSeconds, 86400); // capped at 24 hours
  assert.equal(job.maxRetries, 10); // capped at 10
});

test('enforces minimum timeout bounds', () => {
  const [job] = validatePipelineJobs([
    {
      id: 'build',
      command: 'npm run build',
      timeoutSeconds: 2, // under min
      maxRetries: -5, // under min
    },
  ]);

  assert.equal(job.timeoutSeconds, 10); // floor at 10s
  assert.equal(job.maxRetries, 0); // floor at 0
});
