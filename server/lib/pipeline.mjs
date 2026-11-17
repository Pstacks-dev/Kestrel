export function validatePipelineJobs(jobs){
  const fail=message=>{throw Object.assign(new Error(message),{status:400})};
  if(!Array.isArray(jobs)||jobs.length<1||jobs.length>100)fail('A pipeline must contain 1–100 jobs');
  if(jobs.some(j=>!j||typeof j!=='object'||Array.isArray(j)))fail('Every job must be an object');
  const safe=jobs.map((j,i)=>({
    id:String(j.id||`job-${i+1}`),name:String(j.name||`Job ${i+1}`).slice(0,160),stage:String(j.stage||'build').slice(0,80),
    command:String(j.command||''),needs:Array.isArray(j.needs)?j.needs.map(String):[],
    memory:Math.min(8192,Math.max(256,Number.isFinite(Number(j.memoryLimitMb))?Number(j.memoryLimitMb):2048)),
    cpu:Math.min(4000,Math.max(250,Number.isFinite(Number(j.cpuMillicores))?Number(j.cpuMillicores):1000))
  }));
  const ids=new Set(safe.map(j=>j.id));
  if(ids.size!==safe.length)fail('Job IDs must be unique');
  for(const j of safe){if(!j.command.trim()||j.command.length>12000)fail(`Job ${j.id} must have a command no longer than 12,000 characters`);if(j.needs.some(n=>!ids.has(n)||n===j.id))fail(`Job ${j.id} has an invalid dependency`);}
  const map=new Map(safe.map(j=>[j.id,j]));const visiting=new Set(),visited=new Set();
  function visit(id){if(visiting.has(id))return false;if(visited.has(id))return true;visiting.add(id);for(const dep of map.get(id).needs)if(!visit(dep))return false;visiting.delete(id);visited.add(id);return true;}
  if(!safe.every(j=>visit(j.id)))fail('Pipeline dependencies contain a cycle');
  return safe;
}
