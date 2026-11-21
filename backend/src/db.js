// Postgres connection pool, transactions and migrations.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export function createDb({ connectionString, schema, max = 10 }) {
  const pool = new pg.Pool({
    connectionString,
    max,
    // Tests run inside their own schema so they never touch real data.
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));

  const query = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;
  const many = async (text, params) => (await pool.query(text, params)).rows;

  // Runs fn(client) inside BEGIN/COMMIT. The client has the same one/many helpers.
  async function tx(fn) {
    const client = await pool.connect();
    const c = {
      query: (t, p) => client.query(t, p),
      one: async (t, p) => (await client.query(t, p)).rows[0] ?? null,
      many: async (t, p) => (await client.query(t, p)).rows,
    };
    try {
      await client.query('begin');
      const result = await fn(c);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Applies migrations/NNN_*.sql in order. The advisory lock stops several
  // instances starting at once from running the same migration twice.
  async function migrate(dir) {
    const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    await tx(async (c) => {
      await c.query('select pg_advisory_xact_lock(727274)');
      await c.query('create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())');
      const done = new Set((await c.many('select version from schema_migrations')).map((r) => r.version));
      for (const file of files) {
        if (done.has(file)) continue;
        await c.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await c.query('insert into schema_migrations (version) values ($1)', [file]);
        console.log(`[db] applied ${file}`);
      }
    });
  }

  return { pool, query, one, many, tx, migrate, close: () => pool.end() };
}

export const isUniqueViolation = (err) => err?.code === '23505';
