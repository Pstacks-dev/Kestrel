const API_BASE = 'https://api.render.com/v1';

export async function verifyRenderCredential(token, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (typeof token !== 'string' || token.length < 8) {
    return { ok: false, error: 'API token is missing or invalid' };
  }
  try {
    const response = await fetchImpl(`${API_BASE}/services?limit=1`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'Render rejected this token. Check its permissions.' };
    }
    if (!response.ok) {
      return { ok: false, error: `Render API returned HTTP ${response.status}` };
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) {
      return { ok: false, error: 'Render API returned an unexpected response' };
    }
    return { ok: true, provider: 'render', serviceCountSample: payload.length };
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { ok: false, error: 'Render API verification timed out' };
    }
    return { ok: false, error: 'Could not reach Render API' };
  }
}
