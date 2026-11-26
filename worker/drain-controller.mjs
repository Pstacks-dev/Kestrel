export function createDrainController({
  activeJobs,
  isManagedImageBuildActive = () => false,
  timeoutMs = 60_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  stopContainer = () => {},
  killChild = (child) => child?.kill?.('SIGTERM'),
  forceExit = () => {},
  logger = console,
}) {
  let started = false;
  let timer = null;

  return {
    begin(signal) {
      if (started) return false;
      started = true;
      if (activeJobs.size === 0 && !isManagedImageBuildActive()) return true;

      timer = setTimeoutImpl(() => {
        logger.warn?.('Worker drain timeout exceeded; stopping remaining executions.');
        for (const { abortController, containerName, child } of activeJobs.values()) {
          if (abortController) {
            abortController.abort();
          } else {
            if (containerName) stopContainer(containerName);
            if (child) killChild(child);
          }
        }
        forceExit(signal);
      }, Math.max(1000, Number(timeoutMs) || 60_000));
      timer?.unref?.();
      return true;
    },

    complete() {
      if (timer) clearTimeoutImpl(timer);
      timer = null;
    },
  };
}
