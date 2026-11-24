// Dedicated Vercel function for the post-CI managed deployment queue.
// Vercel invokes this endpoint on schedule; the queue remains durable in Postgres.
import app from '../../server/control-plane.mjs';
export default app;
