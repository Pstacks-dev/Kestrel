import { validateContainerBuildRequest } from '../lib/container-build-validation.mjs';

const BUILD_ROLES = ['owner','admin','developer'];

export function registerContainerBuildRoutes(app, { userAuth, query, transaction }) {
  app.get('/api/projects/:projectId/container-build-settings', userAuth, async (req,res) => {
    try {
      const result=await query(
        `select auto_build_enabled as "autoBuildEnabled",registry_host as "registryHost",image_repository as "imageRepository",
          dockerfile_path as "dockerfilePath",context_path as "contextPath",username_secret as "usernameSecret",
          password_secret as "passwordSecret",updated_at as "updatedAt"
         from public.container_build_settings s join public.organization_members m on m.organization_id=s.organization_id
         where s.project_id=$1 and m.user_id=$2`,
        [req.params.projectId,req.user.id]
      );
      res.json({settings:result.rows[0]||null});
    }catch{res.status(500).json({error:'Could not load container build settings'});}
  });

  app.put('/api/projects/:projectId/container-build-settings', userAuth, async (req,res) => {
    const body=req.body||{};
    try {
      const project=await query(
        `select p.organization_id,m.role from public.projects p join public.organization_members m on m.organization_id=p.organization_id
         where p.id=$1 and m.user_id=$2`,
        [req.params.projectId,req.user.id]
      );
      if(!project.rowCount)return res.status(404).json({error:'Project not found'});
      if(!BUILD_ROLES.includes(project.rows[0].role))return res.status(403).json({error:'Developer access required to configure auto-build'});
      const validated=validateContainerBuildRequest({...body,commitSha:'a'.repeat(40)});
      if(!validated.ok)return res.status(400).json({error:validated.error});
      const secretNames=[validated.config.usernameSecret,validated.config.passwordSecret];
      if(body.autoBuildEnabled){
        const secrets=await query('select name from public.project_secrets where project_id=$1 and name=any($2)',[req.params.projectId,secretNames]);
        if(secrets.rowCount!==2)return res.status(400).json({error:'Add the registry username and password secrets before enabling automatic builds'});
      }
      const saved=await query(
        `insert into public.container_build_settings(project_id,organization_id,auto_build_enabled,registry_host,image_repository,dockerfile_path,context_path,username_secret,password_secret,created_by,updated_at)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
         on conflict(project_id) do update set auto_build_enabled=excluded.auto_build_enabled,registry_host=excluded.registry_host,
          image_repository=excluded.image_repository,dockerfile_path=excluded.dockerfile_path,context_path=excluded.context_path,
          username_secret=excluded.username_secret,password_secret=excluded.password_secret,updated_at=now()
         returning auto_build_enabled as "autoBuildEnabled",registry_host as "registryHost",image_repository as "imageRepository",
          dockerfile_path as "dockerfilePath",context_path as "contextPath",username_secret as "usernameSecret",password_secret as "passwordSecret",updated_at as "updatedAt"`,
        [req.params.projectId,project.rows[0].organization_id,Boolean(body.autoBuildEnabled),validated.config.registryHost,validated.config.imageRepository,validated.config.dockerfilePath,validated.config.contextPath,validated.config.usernameSecret,validated.config.passwordSecret,req.user.id]
      );
      res.json({settings:saved.rows[0]});
    }catch{res.status(500).json({error:'Could not save container build settings'});}
  });

  app.get('/api/projects/:projectId/container-builds', userAuth, async (req,res) => {
    try {
      const result=await query(
        `select b.id,b.source_pipeline_run_id as "sourcePipelineRunId",b.build_pipeline_run_id as "buildPipelineRunId",
          b.registry_host as "registryHost",b.image_repository as "imageRepository",b.image_tag as "imageTag",
          b.image_ref as "imageRef",b.image_digest as "imageDigest",b.dockerfile_path as "dockerfilePath",
          b.context_path as "contextPath",b.status,b.error_message as "errorMessage",b.created_at as "createdAt",
          b.updated_at as "updatedAt",b.completed_at as "completedAt",r.commit_sha as "commitSha"
         from public.container_builds b
         join public.pipeline_runs r on r.id=b.source_pipeline_run_id
         join public.organization_members m on m.organization_id=b.organization_id
         where b.project_id=$1 and m.user_id=$2 order by b.created_at desc limit 50`,
        [req.params.projectId,req.user.id]
      );
      res.json({builds:result.rows});
    } catch {res.status(500).json({error:'Could not load container builds'});}
  });

  app.post('/api/projects/:projectId/container-builds', userAuth, async (req,res) => {
    const body=req.body||{};
    try {
      const source=await query(
        `select p.organization_id,p.repository_url,p.default_branch,r.status,r.branch,r.commit_sha,m.role
         from public.projects p join public.pipeline_runs r on r.project_id=p.id
         join public.organization_members m on m.organization_id=p.organization_id
         where p.id=$1 and r.id=$2 and m.user_id=$3`,
        [req.params.projectId,body.sourcePipelineRunId,req.user.id]
      );
      if(!source.rowCount)return res.status(404).json({error:'Project or source pipeline run not found'});
      const row=source.rows[0];
      if(!BUILD_ROLES.includes(row.role))return res.status(403).json({error:'Developer access required to build container images'});
      if(row.status!=='succeeded')return res.status(409).json({error:'Container builds require a successful pipeline run'});
      if(!row.commit_sha)return res.status(409).json({error:'Source pipeline run does not have a validated commit SHA'});
      const validated=validateContainerBuildRequest({...body,commitSha:row.commit_sha});
      if(!validated.ok)return res.status(400).json({error:validated.error});
      const secretNames=[validated.config.usernameSecret,validated.config.passwordSecret];
      const secrets=await query('select name from public.project_secrets where project_id=$1 and name=any($2)',[req.params.projectId,secretNames]);
      if(secrets.rowCount!==2)return res.status(400).json({error:'Add the configured registry username and password to project secrets before building'});
      const created=await transaction(async(c)=>{
        // Serialize build-run numbering for this project to avoid concurrent MAX()+1 collisions.
        await c.query('select id from public.projects where id=$1 for update',[req.params.projectId]);
        const next=await c.query('select coalesce(max(run_number),0)+1 as n from public.pipeline_runs where project_id=$1',[req.params.projectId]);
        const buildRun=await c.query(
          `insert into public.pipeline_runs(project_id,run_number,branch,commit_sha,commit_message,status,triggered_by)
           values($1,$2,$3,$4,$5,'queued',$6) returning id,run_number`,
          [req.params.projectId,next.rows[0].n,row.branch||row.default_branch,row.commit_sha,('Container image build: '+validated.config.imageRef).slice(0,300),req.user.id]
        );
        const job=await c.query(
          `insert into public.jobs(run_id,external_id,name,stage,command,needs,memory_limit_mb,cpu_millicores,timeout_seconds,max_retries,job_type,container_build_config)
           values($1,'container-image','Build and push container image','package','kestrel-container-build', '{}',4096,2000,1800,0,'container_build',$2::jsonb) returning id`,
          [buildRun.rows[0].id,JSON.stringify(validated.config)]
        );
        const record=await c.query(
          `insert into public.container_builds(organization_id,project_id,source_pipeline_run_id,build_pipeline_run_id,job_id,registry_host,image_repository,image_tag,dockerfile_path,context_path,created_by)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           returning id,status,registry_host as "registryHost",image_repository as "imageRepository",image_tag as "imageTag",created_at as "createdAt"`,
          [row.organization_id,req.params.projectId,body.sourcePipelineRunId,buildRun.rows[0].id,job.rows[0].id,validated.config.registryHost,validated.config.imageRepository,validated.config.imageTag,validated.config.dockerfilePath,validated.config.contextPath,req.user.id]
        );
        await c.query('insert into public.audit_events(organization_id,actor_id,action,target_type,target_id,metadata) values($1,$2,$3,$4,$5,$6::jsonb)',[row.organization_id,req.user.id,'container_build.queued','container_build',record.rows[0].id,JSON.stringify({sourcePipelineRunId:body.sourcePipelineRunId,imageRef:validated.config.imageRef})]);
        return {build:record.rows[0],buildPipelineRunId:buildRun.rows[0].id,buildRunNumber:buildRun.rows[0].run_number};
      });
      res.status(201).json(created);
    } catch(error) {
      res.status(error.status||500).json({error:error.status?error.message:'Could not queue container image build'});
    }
  });
}
