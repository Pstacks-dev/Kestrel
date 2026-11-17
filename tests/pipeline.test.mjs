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
