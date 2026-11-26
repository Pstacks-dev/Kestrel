import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePipelineJobs } from '../server/lib/pipeline.mjs';

test('accepts a valid dependency graph and applies resource defaults',()=>{
 const jobs=validatePipelineJobs([{id:'install',command:'npm ci'},{id:'test',command:'npm test',needs:['install']}]);
 assert.equal(jobs.length,2);assert.equal(jobs[0].memory,2048);assert.equal(jobs[1].needs[0],'install');
});
test('rejects duplicate job identifiers',()=>assert.throws(()=>validatePipelineJobs([{id:'x',command:'true'},{id:'x',command:'true'}]),/unique/));
test('rejects unknown dependencies',()=>assert.throws(()=>validatePipelineJobs([{id:'x',command:'true',needs:['missing']}]),/invalid dependency/));
test('rejects dependency cycles',()=>assert.throws(()=>validatePipelineJobs([{id:'a',command:'true',needs:['b']},{id:'b',command:'true',needs:['a']}]),/cycle/));
test('rejects empty or oversized commands',()=>{assert.throws(()=>validatePipelineJobs([{command:'  '}]),/must have a command/);assert.throws(()=>validatePipelineJobs([{command:'x'.repeat(12001)}]),/12,000/)});
test('caps resource requests',()=>{const [job]=validatePipelineJobs([{command:'true',memoryLimitMb:50000,cpuMillicores:50000}]);assert.equal(job.memory,8192);assert.equal(job.cpu,4000)});

test('keeps safe relative artifact paths and removes duplicates', () => {
 const [result] = validatePipelineJobs([{id:'build',command:'npm run build',artifacts:['dist/app.js','dist/app.js','coverage/report.xml']}]);
 assert.deepEqual(result.artifacts,['dist/app.js','coverage/report.xml']);
});
test('rejects traversal, absolute, drive-letter and malformed artifact paths', () => {
 const [result] = validatePipelineJobs([{id:'build',command:'npm run build',artifacts:['../secret.txt','dist/../../secret','/etc/passwd','C:/Windows/win.ini','C:\\temp\\secret','./dist/app.js','dist//app.js','']}]);
 assert.deepEqual(result.artifacts,[]);
});
test('caps declared artifact count at fifty', () => {
 const paths=Array.from({length:60},(_,i)=>`dist/file-${i}.js`);
 const [result]=validatePipelineJobs([{id:'build',command:'npm run build',artifacts:paths}]);
 assert.equal(result.artifacts.length,50);
});

test('accepts safe nested working directories and defaults to repository root', () => {
 const [nested,root] = validatePipelineJobs([
  {id:'build',command:'npm run build',workingDirectory:'apps/web'},
  {id:'test',command:'npm test'},
 ]);
 assert.equal(nested.workingDirectory,'apps/web');
 assert.equal(root.workingDirectory,'.');
});
test('rejects unsafe pipeline working directories', () => {
 for (const workingDirectory of ['../outside','apps/../../secret','/etc','C:/repo','apps\\\\web','apps//web','./apps/web','apps/']) {
  assert.throws(() => validatePipelineJobs([{id:'build',command:'npm run build',workingDirectory}]),/unsafe working directory/);
 }
});
