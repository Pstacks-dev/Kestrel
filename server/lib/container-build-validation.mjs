const allowedRegistryHosts=new Set(['ghcr.io','docker.io']);
const validSecretName=(value)=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
const validRelativePath=(value,{allowDot=false}={})=>typeof value==='string'&&value.length<=512&&(allowDot&&value==='.'||!value.startsWith('/')&&!value.includes('\\')&&! /^[A-Za-z]:/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!part.split('').some(ch=>ch.charCodeAt(0)<32)));

export function validateContainerBuildRequest(input={}) {
  const fail=(error)=>({ok:false,error});
  const registryHost=String(input.registryHost||'').trim().toLowerCase();
  if(!allowedRegistryHosts.has(registryHost))return fail('Only GitHub Container Registry (ghcr.io) and Docker Hub (docker.io) are supported initially');
  const imageRepository=String(input.imageRepository||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/.test(imageRepository)||imageRepository.includes('..'))return fail('Image repository must be a lowercase namespace/repository path');
  const commitSha=String(input.commitSha||'');
  if(!/^[a-f0-9]{40,64}$/i.test(commitSha))return fail('A verified source commit SHA is required');
  const imageTag=String(input.imageTag||('sha-'+commitSha.slice(0,12))).trim();
  if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(imageTag))return fail('Image tag is invalid');
  const dockerfilePath=String(input.dockerfilePath||'Dockerfile').trim();
  if(!validRelativePath(dockerfilePath))return fail('Dockerfile path must be a safe relative path');
  const contextPath=String(input.contextPath||'.').trim();
  if(!validRelativePath(contextPath,{allowDot:true}))return fail('Build context must be a safe relative path');
  const usernameSecret=String(input.usernameSecret||'REGISTRY_USERNAME').trim();
  const passwordSecret=String(input.passwordSecret||'REGISTRY_PASSWORD').trim();
  if(!validSecretName(usernameSecret)||!validSecretName(passwordSecret)||usernameSecret===passwordSecret)return fail('Registry secret names are invalid or identical');
  const imageName=registryHost+'/'+imageRepository;
  return {ok:true,config:{registryHost,imageRepository,imageTag,dockerfilePath,contextPath,usernameSecret,passwordSecret,commitSha,imageRef:imageName+':'+imageTag,imageName}};
}
