// Vercel serverless entry: every /api/* and /photos/* request is rewritten here
// (see vercel.json). The frontend is served as static files from frontend/.
import { getApp } from '../backend/src/bootstrap.js';

export default async function handler(req, res) {
  const app = await getApp();
  return app.handler(req, res);
}
