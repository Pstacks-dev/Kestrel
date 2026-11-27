/** Abort work immediately when the control plane confirms that its lease is no longer owned. */
export function abortIfLeaseLost(error, controller) {
  const message = String(error?.message || error || '');
  const lost = error?.status === 409 || /\\b409\\b|lease.{0,40}expired|expired.{0,40}lease/i.test(message);
  if (lost && controller && !controller.signal.aborted) controller.abort();
  return lost;
}
