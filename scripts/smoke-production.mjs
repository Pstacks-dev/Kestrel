import { runProductionSmoke } from '../server/lib/production-smoke.mjs';

try {
  const result = await runProductionSmoke();
  console.log(JSON.stringify(result));
} catch (error) {
  console.error('[production-smoke] Health verification failed:', error.message);
  process.exitCode = 1;
}
