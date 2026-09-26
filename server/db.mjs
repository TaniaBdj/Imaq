/**
 * Database access. Server-side ONLY — the browser never sees DATABASE_URL.
 *
 *  - DATABASE_URL set  → node-postgres Pool (Railway PostgreSQL). TLS on for non-local hosts.
 *  - DATABASE_URL unset → embedded PostgreSQL (PGlite) for local development and tests.
 *    Refused when NODE_ENV=production so a misconfigured deployment fails loudly.
 */
import { readFile } from 'node:fs/promises';

const SCHEMA_URL = new URL('./schema.sql', import.meta.url);

/** @returns {Promise<{query:(text:string, params?:any[])=>Promise<{rows:any[]}>, exec:(sql:string)=>Promise<void>, tx:(fn)=>Promise<any>, close:()=>Promise<void>, kind:string}>} */
export async function createDb({ url = process.env.DATABASE_URL, embeddedDir = process.env.IMAQ_LOCAL_DB_DIR, env = process.env.NODE_ENV } = {}) {
  if (url) {
    const { default: pg } = await import('pg');
    // NUMERIC → JS number (values here are small measurements).
    pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
    const host = safeHost(url);
    const local = host === 'localhost' || host === '127.0.0.1';
    const pool = new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
    return {
      kind: 'postgres',
      query: (text, params = []) => pool.query(text, params),
      exec: async (sql) => { await pool.query(sql); },
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({ query: (t, p = []) => client.query(t, p) });
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (env === 'production') throw new Error('DATABASE_URL is required in production');
  const { PGlite } = await import('@electric-sql/pglite');
  const { types } = await import('@electric-sql/pglite');
  const parsers = { [types.NUMERIC]: (v) => (v === null ? null : Number(v)), [types.INT8]: (v) => (v === null ? null : Number(v)) };
  const db = embeddedDir ? new PGlite(embeddedDir, { parsers }) : new PGlite({ parsers });
  await db.waitReady;
  let queue = Promise.resolve();
  return {
    kind: embeddedDir ? 'embedded-postgres (PGlite, persisted)' : 'embedded-postgres (PGlite, in-memory)',
    query: (text, params = []) => db.query(text, params),
    exec: async (sql) => { await db.exec(sql); },
    // PGlite is single-connection: serialise transactions.
    tx(fn) {
      const run = queue.then(() => db.transaction((t) => fn({ query: (q, p = []) => t.query(q, p) })));
      queue = run.catch(() => {});
      return run;
    },
    close: () => db.close(),
  };
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export async function migrate(db) {
  await db.exec(await readFile(SCHEMA_URL, 'utf8'));
}
