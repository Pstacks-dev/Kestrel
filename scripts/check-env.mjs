import 'dotenv/config';
import { validateKestrelEnvironment } from '../server/lib/production-preflight.mjs';

const { errors, warnings } = validateKestrelEnvironment(process.env, process.versions.node);

if (warnings.length) {
  console.log('Configuration notes:');
  for (const warning of warnings) console.log(`  - ${warning}`);
}

if (errors.length) {
  console.error('Production preflight failed:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log('Kestrel environment preflight passed.');
