// Local / long-running server entry point. On Vercel, api/index.js is used instead.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getApp } from './src/bootstrap.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

// The backend can also serve the web app, so one URL (or one tunnel) works for phones.
// Set SERVE_FRONTEND=false when the frontend is hosted separately.
const frontendDir = path.resolve(ROOT, env.FRONTEND_DIR || '../frontend');
const serveFrontend = env.SERVE_FRONTEND !== 'false' && fs.existsSync(frontendDir);

const app = await getApp({ frontendDir: serveFrontend ? frontendDir : null });

const port = Number(env.PORT) || 3000;
const server = http.createServer(app.handler);
server.listen(port, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i?.family === 'IPv4' && !i.internal)?.address;
  console.log('Station Egg Hunt API running:');
  console.log(`  this laptop:  http://localhost:${port}${serveFrontend ? '' : '/api/health'}`);
  if (lan) console.log(`  same Wi-Fi:   http://${lan}:${port}`);
  console.log(`  database:     ${app.memory ? 'in-memory MongoDB (temporary)' : 'MongoDB at MONGODB_URI'}`);
  console.log(`  web app:      ${serveFrontend ? 'served from ' + frontendDir : 'not served (SERVE_FRONTEND=false)'}`);
  console.log(`  photo check:  ${env.GEMINI_API_KEY ? 'Gemini' : 'honor system (no GEMINI_API_KEY)'}`);
});

// Let in-flight requests finish when the platform stops this instance.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close(() => app.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
