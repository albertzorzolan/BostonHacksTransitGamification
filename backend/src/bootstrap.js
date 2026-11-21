// Builds the app from env vars. Shared by the local server (server.js) and the
// Vercel function (api/index.js). The app is created once per process and reused,
// so a warm serverless instance keeps its database connection pool.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createDb, startMemoryMongo } from './db.js';
import { createMbta } from './mbta.js';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let appPromise = null;

export function getApp(extra = {}) {
  appPromise ??= build(extra).catch((err) => {
    appPromise = null; // let the next request retry
    throw err;
  });
  return appPromise;
}

async function build({ frontendDir = null } = {}) {
  const env = process.env;
  let uri = env.MONGODB_URI;
  let memory = null;
  if (!uri) {
    if (env.VERCEL || env.NODE_ENV === 'production') throw new Error('MONGODB_URI is not set.');
    memory = await startMemoryMongo();
    uri = memory.uri;
    console.warn('[db] MONGODB_URI not set: using a temporary in-memory MongoDB (data is lost on restart).');
  }
  const db = await createDb({
    uri,
    dbName: env.MONGODB_DB || 'egghunt',
    maxPoolSize: Number(env.DB_POOL_SIZE) || 10,
  });
  const app = await createApp({
    db,
    mbta: createMbta({ apiKey: env.MBTA_API_KEY, cacheFile: path.join(BACKEND, 'data', 'stations.json') }),
    geminiKey: env.GEMINI_API_KEY ?? '',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.8-flash',
    frontendDir,
    corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  });
  return {
    ...app,
    memory: Boolean(memory),
    close: async () => {
      await db.close();
      await memory?.stop();
    },
  };
}
