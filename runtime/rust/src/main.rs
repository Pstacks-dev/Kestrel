use anyhow::{anyhow, Context, Result};
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, env, path::{Component, Path, PathBuf}, process::Stdio, time::Duration};
use tokio::{fs, io::{AsyncBufReadExt, BufReader}, process::Command, task::JoinSet, time};
use tracing::{error, info, warn};

#[derive(Clone)]
struct Config {
    api: String, token: String, worker_id: String, hostname: String,
    region: String, concurrency: u32, workdir: PathBuf, host_workdir: PathBuf,
    image: String, network: String, docker: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimResponse { job: Option<Job> }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String, command: String, #[serde(rename = "leaseToken")] lease_token: String, project_id: String,
    repository_url: Option<String>, source_type: Option<String>,
    branch: Option<String>, commit_sha: Option<String>,
    timeout_seconds: Option<u64>, memory_limit_mb: Option<u32>,
    cpu_millicores: Option<u32>, secrets: Option<HashMap<String, String>>, #[serde(alias = "artifact_paths")] artifact_paths: Option<Vec<String>>,
    job_type: Option<String>, deployment: Option<DeploymentConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentConfig {
    environment_id: String, release_id: String, image: String, container_name: String, host_port: u16, container_port: u16,
    health_path: String, health_timeout_seconds: u64, public_url: Option<String>,
    secret_names: Vec<String>, previous_image: Option<String>, previous_container: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerInfo<'a> { worker_id: &'a str, hostname: &'a str, arch: &'a str, region: &'a str, max_concurrency: u32, runtime: &'a str }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Heartbeat<'a> { worker_id: &'a str, draining: bool }

#[derive(Serialize)]
struct LogEntry<'a> { stream: &'a str, message: &'a str }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogBatch<'a> { lease_token: &'a str, entries: Vec<LogEntry<'a>> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Completion<'a> { lease_token: &'a str, exit_code: i32, duration_ms: u128, status: &'a str }

fn config() -> Result<Config> {
    let get = |key: &str, default: &str| env::var(key).unwrap_or_else(|_| default.into());
    let worker_id = get("KESTREL_WORKER_ID", &format!("{}-{}", get("HOSTNAME", "worker"), &uuid::Uuid::new_v4().to_string()[..8]));
    let api = get("KESTREL_API_URL", "");
    let token = get("KESTREL_WORKER_TOKEN", "");
    anyhow::ensure!(!api.is_empty() && !token.is_empty(), "KESTREL_API_URL and KESTREL_WORKER_TOKEN are required");
    Ok(Config {
        api: api.trim_end_matches('/').to_string(), token, worker_id,
        hostname: get("HOSTNAME", "kestrel-worker"), region: get("KESTREL_REGION", "unknown"),
        concurrency: get("KESTREL_CONCURRENCY", "1").parse().unwrap_or(1).clamp(1, 32),
        workdir: PathBuf::from(get("KESTREL_WORKER_WORKDIR", "/var/lib/kestrel/work")),
        host_workdir: PathBuf::from(get("KESTREL_WORKER_HOST_WORKDIR", &get("KESTREL_WORKER_WORKDIR", "/var/lib/kestrel/work"))),
        image: get("KESTREL_JOB_IMAGE", "node:22-bookworm-slim"),
        network: get("KESTREL_JOB_NETWORK", "bridge"), docker: get("KESTREL_DOCKER_BIN", "docker"),
    })
}

fn client(cfg: &Config) -> Result<Client> {
    let mut headers = header::HeaderMap::new();
    headers.insert(header::AUTHORIZATION, format!("Bearer {}", cfg.token).parse()?);
    headers.insert("x-worker-id", cfg.worker_id.parse()?);
    Ok(Client::builder().default_headers(headers).timeout(Duration::from_secs(30)).build()?)
}

async fn post<T: Serialize + ?Sized>(http: &Client, cfg: &Config, path: &str, body: &T) -> Result<reqwest::Response> {
    let response = http.post(format!("{}{}", cfg.api, path)).json(body).send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(anyhow!("Kestrel API {} returned {}: {}", path, status, detail));
    }
    Ok(response)
}

async fn register(http: &Client, cfg: &Config) -> Result<()> {
    let arch = format!("linux/{}", env::consts::ARCH);
    post(http, cfg, "/api/workers/register", &WorkerInfo {
        worker_id: &cfg.worker_id, hostname: &cfg.hostname,
        arch: &arch, region: &cfg.region, max_concurrency: cfg.concurrency, runtime: "rust",
    }).await?;
    info!(worker_id = %cfg.worker_id, "registered with Kestrel control plane");
    Ok(())
}

async fn heartbeat(http: &Client, cfg: &Config) -> Result<()> {
    post(http, cfg, "/api/workers/heartbeat", &Heartbeat { worker_id: &cfg.worker_id, draining: false }).await?;
    Ok(())
}

async fn claim(http: &Client, cfg: &Config) -> Result<Option<Job>> {
    let response = post(http, cfg, "/api/workers/claim", &Heartbeat { worker_id: &cfg.worker_id, draining: false }).await?;
    Ok(response.json::<ClaimResponse>().await?.job)
}

fn docker_host_workspace_path(worker_root: &Path, host_root: &Path, workspace: &Path) -> Result<PathBuf> {
    let worker_root = worker_root.canonicalize().unwrap_or_else(|_| worker_root.to_path_buf());
    let workspace = workspace.canonicalize().unwrap_or_else(|_| workspace.to_path_buf());
    let relative = workspace.strip_prefix(&worker_root)
        .map_err(|_| anyhow!("job workspace is outside the configured worker root"))?;
    Ok(host_root.join(relative))
}

fn safe_relative_path(value: &str) -> Result<PathBuf> {
    let path = Path::new(value);
    anyhow::ensure!(!path.as_os_str().is_empty() && !path.is_absolute() && !value.contains('\\') && !value.contains('\0'), "invalid source path");
    for component in path.components() {
        anyhow::ensure!(matches!(component, Component::Normal(_)), "unsafe source path");
    }
    Ok(path.to_path_buf())
}

async fn stage_uploaded_source(http: &Client, cfg: &Config, job: &Job, workspace: &Path) -> Result<()> {
    let response = http.get(format!("{}/api/workers/projects/{}/source-files", cfg.api, job.project_id)).send().await?;
    anyhow::ensure!(response.status().is_success(), "could not fetch uploaded project source");
    let body: serde_json::Value = response.json().await?;
    let files = body["files"].as_array().ok_or_else(|| anyhow!("source API returned no files array"))?;
    anyhow::ensure!(!files.is_empty() && files.len() <= 500, "uploaded source file count is invalid");
    let mut total: u64 = 0;
    for file in files {
        let relative = safe_relative_path(file["path"].as_str().unwrap_or(""))?;
        let url = file["url"].as_str().ok_or_else(|| anyhow!("source file has no signed URL"))?;
        // Signed object URLs are fetched without the worker-authenticated API client.
        // Never forward the Kestrel worker bearer token to the storage host.
        let response = Client::new().get(url).send().await?;
        anyhow::ensure!(response.status().is_success(), "source download failed");
        let bytes = response.bytes().await?;
        anyhow::ensure!(bytes.len() <= 20 * 1024 * 1024, "source file exceeds 20 MiB");
        total += bytes.len() as u64;
        anyhow::ensure!(total <= 250 * 1024 * 1024, "project source exceeds 250 MiB");
        let destination = workspace.join(relative);
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent).await?; }
        fs::write(destination, bytes).await?;
    }
    Ok(())
}

async fn stage_git_source(_cfg: &Config, job: &Job, workspace: &Path) -> Result<()> {
    let url = job.repository_url.as_deref().ok_or_else(|| anyhow!("Git project has no repository URL"))?;
    let mut clone = Command::new("git");
    clone.args(["clone", "--depth", "1", "--", url]).arg(workspace).stdout(Stdio::null()).stderr(Stdio::piped());
    let output = clone.output().await.context("starting git clone")?;
    anyhow::ensure!(output.status.success(), "git clone failed: {}", String::from_utf8_lossy(&output.stderr));
    if let Some(commit) = &job.commit_sha {
        let output = Command::new("git").arg("-C").arg(workspace).args(["fetch", "--depth", "1", "origin", commit]).output().await?;
        anyhow::ensure!(output.status.success(), "could not fetch requested commit");
        let output = Command::new("git").arg("-C").arg(workspace).args(["checkout", "--detach", commit]).output().await?;
        anyhow::ensure!(output.status.success(), "could not checkout requested commit");
    } else if let Some(branch) = &job.branch {
        let valid = Command::new("git").args(["check-ref-format", "--branch", branch]).output().await?;
        anyhow::ensure!(valid.status.success(), "requested Git branch name is invalid");
        let fetched = Command::new("git").arg("-C").arg(workspace)
            .args(["fetch", "--depth", "1", "origin", branch]).output().await?;
        anyhow::ensure!(fetched.status.success(), "could not fetch requested Git branch");
        let checked_out = Command::new("git").arg("-C").arg(workspace)
            .args(["checkout", "-B", branch, "FETCH_HEAD"]).output().await?;
        anyhow::ensure!(checked_out.status.success(), "could not checkout requested Git branch");
    }
    Ok(())
}

async fn cancellation_requested(http: &Client, cfg: &Config, job: &Job) -> Result<bool> {
    let response = http.get(format!("{}/api/workers/jobs/{}/status", cfg.api, job.id))
        .header("x-kestrel-lease", &job.lease_token)
        .send().await?;
    anyhow::ensure!(response.status().is_success(), "could not check job cancellation status");
    let body: serde_json::Value = response.json().await?;
    Ok(body["status"].as_str() == Some("canceled"))
}

async fn flush_log(http: &Client, cfg: &Config, job: &Job, stream: &str, message: &str) -> Result<()> {
    let entries = vec![LogEntry { stream, message }];
    post(http, cfg, &format!("/api/workers/jobs/{}/logs", job.id),
         &LogBatch { lease_token: &job.lease_token, entries }).await?;
    Ok(())
}


async fn upload_artifacts(http: &Client, cfg: &Config, job: &Job, workspace: &Path) -> Result<()> {
    for raw in job.artifact_paths.as_deref().unwrap_or(&[]) {
        let relative = safe_relative_path(raw)?;
        let source = workspace.join(&relative);
        if !source.is_file() { warn!(path = %raw, "declared artifact does not exist; skipping"); continue; }
        // Never follow a build-created symlink outside the job workspace when collecting artifacts.
        let root = workspace.canonicalize()?;
        let canonical_source = source.canonicalize()?;
        anyhow::ensure!(canonical_source.starts_with(&root), "artifact path escapes job workspace: {raw}");
        let metadata = fs::metadata(&canonical_source).await?;
        anyhow::ensure!(metadata.len() <= 100 * 1024 * 1024, "artifact exceeds 100 MiB: {raw}");
        let bytes = fs::read(&canonical_source).await?;
        let name = relative.file_name().and_then(|n| n.to_str()).ok_or_else(|| anyhow!("invalid artifact filename"))?;
        let response = http.put(format!("{}/api/workers/jobs/{}/artifacts/upload", cfg.api, job.id))
            .header("x-kestrel-lease", &job.lease_token)
            .header("x-artifact-name", name)
            .header("x-artifact-content-type", "application/octet-stream")
            .header("content-type", "application/octet-stream")
            .body(bytes).send().await?;
        anyhow::ensure!(response.status().is_success(), "artifact upload failed for {raw}: {}", response.status());
        info!(path = %raw, "artifact uploaded");
    }
    Ok(())
}

fn valid_deployment_image(image: &str) -> bool {
    !image.is_empty() && image.len() <= 255 && !image.contains("..") &&
        image.bytes().all(|b| b.is_ascii_alphanumeric() || b"/._-:@".contains(&b))
}

async fn docker_action(cfg: &Config, http: &Client, job: &Job, args: &[String], action: &str) -> Result<String> {
    let output = Command::new(&cfg.docker).args(args).output().await
        .with_context(|| format!("starting docker {action}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    for line in stdout.lines() {
        let _ = flush_log(http, cfg, job, "stdout", line).await;
    }
    for line in stderr.lines() {
        let _ = flush_log(http, cfg, job, "stderr", line).await;
    }
    anyhow::ensure!(output.status.success(), "docker {action} failed: {}", stderr.chars().take(3000).collect::<String>());
    Ok(stdout.trim().to_string())
}

async fn deployment_health(cfg: &Config, port: u16, path: &str, timeout_seconds: u64) -> bool {
    let Ok(http) = Client::builder().timeout(Duration::from_secs(3)).build() else { return false; };
    let url = format!("http://127.0.0.1:{port}{path}");
    let deadline = time::Instant::now() + Duration::from_secs(timeout_seconds.clamp(5, 300));
    while time::Instant::now() < deadline {
        if let Ok(response) = http.get(&url).send().await {
            if response.status().is_success() { return true; }
        }
        time::sleep(Duration::from_secs(2)).await;
    }
    false
}

async fn run_deployment(http: &Client, cfg: &Config, job: &Job) -> Result<()> {
    let deployment = job.deployment.as_ref().ok_or_else(|| anyhow!("deployment job has no deployment configuration"))?;
    let image = deployment.image.trim();
    anyhow::ensure!(valid_deployment_image(image), "deployment image reference is invalid");
    anyhow::ensure!(deployment.host_port >= 1024 && deployment.container_port > 0, "deployment port is invalid");
    anyhow::ensure!(deployment.health_path.starts_with('/') && !deployment.health_path.contains(".."), "deployment health path is invalid");
    anyhow::ensure!(deployment.environment_id.len() == 36 && deployment.release_id.len() == 36, "deployment identifiers are invalid");

    let _ = flush_log(http, cfg, job, "system", &format!("Pulling deployment image {image}")).await;
    docker_action(cfg, http, job, &["pull".into(), image.into()], "pull").await?;

    let secret_file = std::env::temp_dir().join(format!("kestrel-deploy-{}-{}.env", job.id, uuid::Uuid::new_v4()));
    let mut secret_contents = String::new();
    if let Some(secrets) = &job.secrets {
        for name in &deployment.secret_names {
            if let Some(value) = secrets.get(name) {
                anyhow::ensure!(!value.contains('\n') && !value.contains('\r') && !value.contains('\0'), "deployment secret contains unsupported newline or NUL");
                anyhow::ensure!(!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "deployment secret name is invalid");
                secret_contents.push_str(name);
                secret_contents.push('=');
                secret_contents.push_str(value);
                secret_contents.push('\n');
            }
        }
    }
    let mut secret_file_created = false;
    if !secret_contents.is_empty() {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true).mode(0o600);
        let mut file = options.open(&secret_file)?;
        use std::io::Write;
        file.write_all(secret_contents.as_bytes())?;
        secret_file_created = true;
    }

    let container = deployment.container_name.clone();
    anyhow::ensure!(container.starts_with("kestrel-") && container.len() <= 100 && container.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "deployment container name is invalid");
    let previous_container = deployment.previous_container.as_deref();
    let mut previous_stopped = false;
    if let Some(previous) = previous_container {
        let stopped = Command::new(&cfg.docker).args(["stop", previous]).output().await?;
        previous_stopped = stopped.status.success();
        if previous_stopped {
            let _ = flush_log(http, cfg, job, "system", "Stopped the currently active release before switching traffic").await;
        }
    }

    let mut args = vec![
        "run".into(), "-d".into(), "--name".into(), container.clone(),
        "--restart".into(), "unless-stopped".into(),
        "--publish".into(), format!("{}:{}", deployment.host_port, deployment.container_port),
        "--network".into(), "bridge".into(),
        "--cap-drop=ALL".into(), "--security-opt=no-new-privileges".into(),
        "--pids-limit".into(), "256".into(), "--memory".into(), "2048m".into(),
        "--read-only".into(), "--tmpfs".into(), "/tmp:rw,nosuid,nodev,noexec,size=256m".into(),
    ];
    if secret_file_created {
        args.push("--env-file".into());
        args.push(secret_file.to_string_lossy().to_string());
    }
    args.push(image.into());

    let start_result = docker_action(cfg, http, job, &args, "run").await;
    let healthy = if start_result.is_ok() {
        deployment_health(cfg, deployment.host_port, &deployment.health_path, deployment.health_timeout_seconds).await
    } else { false };

    if !healthy {
        let _ = Command::new(&cfg.docker).args(["stop", &container]).output().await;
        let _ = Command::new(&cfg.docker).args(["rm", "-f", &container]).output().await;
        if previous_stopped {
            if let Some(previous) = previous_container {
                let restored = Command::new(&cfg.docker).args(["start", previous]).output().await;
                if restored.as_ref().is_ok_and(|o| o.status.success()) {
                    let restored_health = deployment_health(cfg, deployment.host_port, &deployment.health_path, 30).await;
                    if restored_health {
                        let _ = flush_log(http, cfg, job, "system", "New release failed health checks; previous release was restored").await;
                    } else {
                        warn!(job_id = %job.id, "previous release restarted but its health check did not pass");
                    }
                } else {
                    warn!(job_id = %job.id, "could not restart previous release container");
                }
            }
        }
        if secret_file_created { let _ = fs::remove_file(&secret_file).await; }
        if let Err(error) = start_result { return Err(error); }
        return Err(anyhow!("deployment health check failed; previous release restoration was attempted"));
    }

    if secret_file_created { fs::remove_file(&secret_file).await?; }
    let _ = flush_log(http, cfg, job, "system", "Deployment is healthy and the new release is active").await;
    if let Some(url) = &deployment.public_url {
        let _ = flush_log(http, cfg, job, "system", &format!("Application URL: {url}")).await;
    }
    Ok(())
}

async fn execute(http: &Client, cfg: &Config, job: Job) -> Result<()> {
    if job.job_type.as_deref() == Some("deployment") {
        let started = std::time::Instant::now();
        let result = run_deployment(http, cfg, &job).await;
        let (exit_code, status) = match result {
            Ok(()) => (0, "succeeded"),
            Err(error) => {
                let _ = flush_log(http, cfg, &job, "stderr", &format!("Deployment failed: {error}")).await;
                (1, "failed")
            }
        };
        let _ = flush_log(http, cfg, &job, "system", &format!("Deployment worker finished with status {status}")).await;
        post(http, cfg, &format!("/api/workers/jobs/{}/complete", job.id),
            &Completion { lease_token: &job.lease_token, exit_code, duration_ms: started.elapsed().as_millis(), status }).await?;
        return Ok(());
    }
    let started = std::time::Instant::now();
    let workspace = cfg.workdir.join(format!("job-{}", job.id));
    if fs::try_exists(&workspace).await? { fs::remove_dir_all(&workspace).await?; }
    fs::create_dir_all(&workspace).await?;

    let stage_result = match job.source_type.as_deref().unwrap_or("git") {
        "upload" => stage_uploaded_source(http, cfg, &job, &workspace).await,
        _ => stage_git_source(cfg, &job, &workspace).await,
    };
    let mut exit_code = 1;
    let mut status = "failed";
    let mut output_text = String::new();

    if let Err(error) = stage_result {
        output_text = format!("Source preparation failed: {error}");
    } else {
        let container = format!("kestrel-job-{}", job.id.replace(|c: char| !c.is_ascii_alphanumeric(), ""));
        // The job container runs as an unprivileged UID; make only its isolated workspace writable.
        let ownership = Command::new("chown").args(["-R", "1000:1000"]).arg(&workspace).output().await?;
        anyhow::ensure!(ownership.status.success(), "could not set job workspace ownership");
        let mut command = Command::new(&cfg.docker);
        let docker_workspace = docker_host_workspace_path(&cfg.workdir, &cfg.host_workdir, &workspace)?;
        command.args([
            "run", "--rm", "--init", "--name", &container,
            "--network", &cfg.network, "--read-only", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--pids-limit", "256",
            "--memory", &format!("{}m", job.memory_limit_mb.unwrap_or(2048).clamp(256, 8192)),
            "--memory-swap", &format!("{}m", job.memory_limit_mb.unwrap_or(2048).clamp(256, 8192)),
            "--cpus", &format!("{:.2}", (job.cpu_millicores.unwrap_or(1000).clamp(250, 8000) as f64) / 1000.0),
            "--user", "1000:1000", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=512m",
            "--mount",
        ]).arg(format!("type=bind,src={},dst=/workspace", docker_workspace.display()))
          .args(["--workdir", "/workspace", "--env", "CI=true", "--env", "KESTREL=true", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp", "--env", "npm_config_cache=/tmp/.npm"]);
        let secret_file = std::env::temp_dir().join(format!("kestrel-secrets-{}-{}.env", job.id, uuid::Uuid::new_v4()));
        if let Some(secrets) = &job.secrets {
            let mut contents = String::new();
            for (key, value) in secrets {
                if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    continue;
                }
                anyhow::ensure!(!value.contains('\n') && !value.contains('\r') && !value.contains('\0'), "secret contains unsupported newline or NUL");
                contents.push_str(key);
                contents.push('=');
                contents.push_str(value);
                contents.push('\n');
            }
            if !contents.is_empty() {
                use std::os::unix::fs::OpenOptionsExt;
                let mut options = std::fs::OpenOptions::new();
                options.create_new(true).write(true).mode(0o600);
                let mut file = options.open(&secret_file)?;
                use std::io::Write;
                file.write_all(contents.as_bytes())?;
                command.arg("--env-file").arg(&secret_file);
            }
        }
        command.arg(&cfg.image).args(["sh", "-lc", &job.command])
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        let timeout = Duration::from_secs(job.timeout_seconds.unwrap_or(1800).clamp(1, 7200));
        let mut child = command.spawn().context("starting isolated Docker job")?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("Docker stdout pipe unavailable"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("Docker stderr pipe unavailable"))?;
        let (log_tx, mut log_rx) = tokio::sync::mpsc::channel::<(&'static str, String)>(256);
        let stdout_tx = log_tx.clone();
        let stdout_reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if stdout_tx.send(("stdout", line)).await.is_err() { break; }
            }
        });
        let stderr_reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if log_tx.send(("stderr", line)).await.is_err() { break; }
            }
        });
        let deadline = time::sleep(timeout);
        tokio::pin!(deadline);
        let mut lease_pulse = time::interval(Duration::from_secs(10));
        lease_pulse.tick().await;
        let mut timed_out = false;
        let mut canceled = false;
        let mut cancel_poll = time::interval(Duration::from_secs(5));
        cancel_poll.tick().await;
        let process_status = loop {
            tokio::select! {
                result = child.wait() => break result.context("waiting for Docker job")?,
                Some((stream, line)) = log_rx.recv() => {
                    if let Err(error) = flush_log(http, cfg, &job, stream, &line.chars().take(8000).collect::<String>()).await {
                        warn!(job_id = %job.id, %error, "streaming job log failed");
                    }
                }
                _ = lease_pulse.tick() => {
                    if let Err(error) = http.post(format!("{}/api/workers/jobs/{}/lease", cfg.api, job.id))
                        .header("x-kestrel-lease", &job.lease_token).send().await {
                        warn!(job_id = %job.id, %error, "job lease refresh failed");
                    }
                }
                _ = cancel_poll.tick() => {
                    match cancellation_requested(http, cfg, &job).await {
                        Ok(true) => {
                            canceled = true;
                            let _ = Command::new(&cfg.docker).args(["kill", &container]).output().await;
                            break child.wait().await.context("waiting for canceled Docker job")?;
                        }
                        Ok(false) => {}
                        Err(error) => warn!(job_id = %job.id, %error, "job cancellation check failed"),
                    }
                }
                _ = &mut deadline => {
                    timed_out = true;
                    // Stop the container itself; killing only the Docker CLI would orphan the build.
                    let _ = Command::new(&cfg.docker).args(["kill", &container]).output().await;
                    break child.wait().await.context("waiting for timed-out Docker job")?;
                }
            }
        };
        while let Some((stream, line)) = log_rx.recv().await {
            let _ = flush_log(http, cfg, &job, stream, &line.chars().take(8000).collect::<String>()).await;
        }
        let _ = stdout_reader.await;
        let _ = stderr_reader.await;
        let _ = fs::remove_file(&secret_file).await;
        exit_code = if timed_out { 124 } else if canceled { 130 } else { process_status.code().unwrap_or(1) };
        if timed_out {
            let _ = flush_log(http, cfg, &job, "system", "Job timed out and was terminated").await;
        }
        if canceled {
            let _ = flush_log(http, cfg, &job, "system", "Job cancellation requested; container stopped").await;
        }
        status = if canceled { "canceled" } else if exit_code == 0 { "succeeded" } else { "failed" };
    }

    if exit_code == 0 {
        if let Err(error) = upload_artifacts(http, cfg, &job, &workspace).await {
            output_text.push_str(&format!("\\nArtifact upload failed: {error}"));
            exit_code = 1;
            status = "failed";
        }
    }
    for line in output_text.lines() {
        let stream = if line.starts_with("[stderr]") { "stderr" } else { "stdout" };
        let _ = flush_log(http, cfg, &job, stream, &line.chars().take(8000).collect::<String>()).await;
    }
    let _ = flush_log(http, cfg, &job, "system", &format!("Rust runtime finished job with status {status}")).await;
    post(http, cfg, &format!("/api/workers/jobs/{}/complete", job.id),
         &Completion { lease_token: &job.lease_token, exit_code, duration_ms: started.elapsed().as_millis(), status }).await?;
    let _ = fs::remove_dir_all(&workspace).await;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let cfg = config()?;
    fs::create_dir_all(&cfg.workdir).await?;
    let http = client(&cfg)?;
    let mut active = JoinSet::new();
    let mut registered = false;
    let mut last_heartbeat = std::time::Instant::now() - Duration::from_secs(30);
    loop {
        if !registered {
            match register(&http, &cfg).await {
                Ok(()) => registered = true,
                Err(error) => warn!(%error, "worker registration failed; will retry"),
            }
        }
        if registered && last_heartbeat.elapsed() >= Duration::from_secs(10) {
            match heartbeat(&http, &cfg).await {
                Ok(()) => last_heartbeat = std::time::Instant::now(),
                Err(error) => warn!(%error, "worker heartbeat failed; will retry"),
            }
        }

        while registered && active.len() < cfg.concurrency as usize {
            match claim(&http, &cfg).await {
                Ok(Some(job)) => {
                    info!(job_id = %job.id, project_id = %job.project_id, "claimed job");
                    let task_http = http.clone();
                    let task_cfg = cfg.clone();
                    active.spawn(async move { execute(&task_http, &task_cfg, job).await });
                }
                Ok(None) => break,
                Err(error) => { warn!(%error, "job claim failed"); break; }
            }
        }

        if active.is_empty() {
            time::sleep(Duration::from_secs(3)).await;
        } else {
            tokio::select! {
                result = active.join_next() => {
                    match result {
                        Some(Ok(Ok(()))) | None => {}
                        Some(Ok(Err(error))) => error!(%error, "worker job execution failed"),
                        Some(Err(error)) => error!(%error, "worker job task panicked"),
                    }
                }
                _ = time::sleep(Duration::from_secs(3)) => {}
            }
        }
    }
}


#[cfg(test)]
mod tests {
    use super::{docker_host_workspace_path, safe_relative_path};

    #[test]
    fn maps_container_workspace_to_host_docker_path() {
        let worker = std::path::Path::new("/var/lib/kestrel/work");
        let host = std::path::Path::new("/srv/kestrel/work");
        let workspace = worker.join("job-123");
        assert_eq!(docker_host_workspace_path(worker, host, &workspace).unwrap(), host.join("job-123"));
    }

    #[test]
    fn rejects_workspace_outside_worker_root() {
        assert!(docker_host_workspace_path(
            std::path::Path::new("/var/lib/kestrel/work"),
            std::path::Path::new("/srv/kestrel/work"),
            std::path::Path::new("/tmp/other")
        ).is_err());
    }

    #[test]
    fn accepts_nested_relative_source_paths() {
        assert_eq!(safe_relative_path("src/main.rs").unwrap().to_string_lossy(), "src/main.rs");
    }

    #[test]
    fn rejects_parent_traversal() {
        assert!(safe_relative_path("../secrets.txt").is_err());
        assert!(safe_relative_path("src/../../secrets.txt").is_err());
    }

    #[test]
    fn rejects_absolute_and_windows_paths() {
        assert!(safe_relative_path("/etc/passwd").is_err());
        assert!(safe_relative_path("..\\secrets.txt").is_err());
    }
}
