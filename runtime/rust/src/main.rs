use anyhow::{anyhow, Context, Result};
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, env, path::{Component, Path, PathBuf}, process::Stdio, time::Duration};
use tokio::{fs, process::Command, time};
use tracing::{error, info, warn};

#[derive(Clone)]
struct Config {
    api: String, token: String, worker_id: String, hostname: String,
    region: String, concurrency: u32, workdir: PathBuf,
    image: String, network: String, docker: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimResponse { job: Option<Job> }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String, command: String, lease_token: String, project_id: String,
    repository_url: Option<String>, source_type: Option<String>,
    branch: Option<String>, commit_sha: Option<String>,
    timeout_seconds: Option<u64>, memory_limit_mb: Option<u32>,
    cpu_millicores: Option<u32>, secrets: Option<HashMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerInfo<'a> { worker_id: &'a str, hostname: &'a str, arch: &'a str, region: &'a str, max_concurrency: u32 }

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
        image: get("KESTREL_JOB_IMAGE", "node:22-bookworm-slim"),
        network: get("KESTREL_JOB_NETWORK", "none"), docker: get("KESTREL_DOCKER_BIN", "docker"),
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
        arch: &arch, region: &cfg.region, max_concurrency: cfg.concurrency,
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

fn safe_relative_path(value: &str) -> Result<PathBuf> {
    let path = Path::new(value);
    anyhow::ensure!(!path.as_os_str().is_empty() && !path.is_absolute(), "invalid source path");
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
        let response = http.get(url).send().await?;
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

async fn stage_git_source(cfg: &Config, job: &Job, workspace: &Path) -> Result<()> {
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
        let _ = Command::new("git").arg("-C").arg(workspace).args(["checkout", branch]).output().await?;
    }
    Ok(())
}

async fn flush_log(http: &Client, cfg: &Config, job: &Job, stream: &str, message: &str) -> Result<()> {
    let entries = vec![LogEntry { stream, message }];
    post(http, cfg, &format!("/api/workers/jobs/{}/logs", job.id),
         &LogBatch { lease_token: &job.lease_token, entries }).await?;
    Ok(())
}

async fn execute(http: &Client, cfg: &Config, job: Job) -> Result<()> {
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
        let mut command = Command::new(&cfg.docker);
        command.args([
            "run", "--rm", "--init", "--name", &container,
            "--network", &cfg.network, "--read-only", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--pids-limit", "256",
            "--memory", &format!("{}m", job.memory_limit_mb.unwrap_or(2048).clamp(256, 8192)),
            "--memory-swap", &format!("{}m", job.memory_limit_mb.unwrap_or(2048).clamp(256, 8192)),
            "--cpus", &format!("{:.2}", (job.cpu_millicores.unwrap_or(1000).clamp(250, 8000) as f64) / 1000.0),
            "--user", "1000:1000", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=512m",
            "--mount",
        ]).arg(format!("type=bind,src={},dst=/workspace", workspace.display()))
          .args(["--workdir", "/workspace", "--env", "CI=true", "--env", "KESTREL=true"]);
        if let Some(secrets) = &job.secrets {
            for (key, value) in secrets {
                if key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    command.args(["--env", &format!("{key}={value}")]);
                }
            }
        }
        command.arg(&cfg.image).args(["sh", "-lc", &job.command])
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        let timeout = Duration::from_secs(job.timeout_seconds.unwrap_or(1800).clamp(1, 7200));
        let output_future = command.output();
        tokio::pin!(output_future);
        let deadline = time::sleep(timeout);
        tokio::pin!(deadline);
        let mut lease_pulse = time::interval(Duration::from_secs(10));
        lease_pulse.tick().await;
        let mut timed_out = false;
        let output = loop {
            tokio::select! {
                result = &mut output_future => break result.context("starting isolated Docker job")?,
                _ = lease_pulse.tick() => {
                    // Empty log batches extend the 45-second job lease while a quiet command runs.
                    if let Err(error) = flush_log(http, cfg, &job, "stdout", "").await {
                        warn!(job_id = %job.id, %error, "job lease refresh failed");
                    }
                }
                _ = &mut deadline => {
                    timed_out = true;
                    let _ = Command::new(&cfg.docker).args(["kill", &container]).output().await;
                    break output_future.await.context("collecting timed-out Docker job")?;
                }
            }
        };
        exit_code = if timed_out { 124 } else { output.status.code().unwrap_or(1) };
        output_text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        if timed_out { output_text.push_str("\\nJob timed out"); }
        status = if exit_code == 0 { "succeeded" } else { "failed" };
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
    loop {
        if let Err(error) = register(&http, &cfg).await { warn!(%error, "worker registration failed"); }
        if let Err(error) = heartbeat(&http, &cfg).await { warn!(%error, "worker heartbeat failed"); }
        match claim(&http, &cfg).await {
            Ok(Some(job)) => {
                info!(job_id = %job.id, project_id = %job.project_id, "claimed job");
                if let Err(error) = execute(&http, &cfg, job).await { error!(%error, "job execution failed"); }
            }
            Ok(None) => time::sleep(Duration::from_secs(3)).await,
            Err(error) => { warn!(%error, "job claim failed"); time::sleep(Duration::from_secs(5)).await; }
        }
    }
}
