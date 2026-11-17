// Vercel catch-all serverless adapter for the existing Express control plane.
// Vercel invokes this on demand; it does not host the persistent worker fleet.
import app from '../server/control-plane.mjs';
export default app;
