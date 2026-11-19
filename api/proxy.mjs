// Vercel rewrite target for the Express control plane.
// Vercel's Vite/static routing does not reliably dispatch nested API paths
// to the catch-all function. This exact function restores the original URL.
import app from '../server/control-plane.mjs';

export default function handler(req, res) {
  const captured = req.query?.__kestrel_path;
  const path = Array.isArray(captured) ? captured.join('/') : String(captured || '');
  const normalized = path.replace(/^\\/+/, '');

  if (!normalized || normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
    return res.status(400).json({ error: 'Invalid API path' });
  }

  const parsed = new URL(req.url || '/', 'http://vercel.internal');
  const query = new URLSearchParams(parsed.search);
  query.delete('__kestrel_path');
  const suffix = query.toString();

  req.url = `/api/${normalized}${suffix ? `?${suffix}` : ''}`;
  return app(req, res);
}
