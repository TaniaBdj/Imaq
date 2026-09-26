/**
 * Imaq server: serves the PWA (static files) and the /api on one origin.
 *   npm start                      (PORT from env, default 8080)
 * DATABASE_URL (Railway PostgreSQL) is read here, server-side only.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, migrate } from './db.mjs';
import { seedDatabase } from './seed.mjs';
import { createApi } from './api.mjs';
import { createSyntheticSensors } from './synthetic-sensors.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Only the PWA is public. server/, data/ (seed), package files and .env are never served.
const PUBLIC = ['index.html', 'manifest.webmanifest', 'sw.js', 'css/', 'js/', 'icons/'];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

export async function startServer({ port = Number(process.env.PORT || 8080), env = process.env, clock = () => Date.now(), quiet = false } = {}) {
  const db = await createDb({ url: env.DATABASE_URL, embeddedDir: env.IMAQ_LOCAL_DB_DIR, env: env.NODE_ENV });
  await migrate(db);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM households`);
  if (!rows[0].n || env.IMAQ_SEED_ON_START === '1') await seedDatabase(db, { now: clock() });
  const synthetic = env.IMAQ_SYNTHETIC_SENSORS === '0' ? null : createSyntheticSensors({ db, clock });
  const api = createApi({ db, synthetic, clock, env });

  const server = createServer(async (req, res) => {
    try {
      if (await api(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const rel = path.replace(/^\/+/, '');
      if (!PUBLIC.some((p) => rel === p || (p.endsWith('/') && rel.startsWith(p)))) throw new Error('not public');
      const file = normalize(join(ROOT, rel));
      if (!file.startsWith(ROOT) || !(await stat(file)).isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch {
      if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  const timer = synthetic ? setInterval(() => synthetic.tick().catch((e) => console.error('[synthetic]', e.message)), 60_000) : null;
  await new Promise((r) => server.listen(port, r));
  if (!quiet) console.log(`Imaq running on port ${server.address().port} · database: ${db.kind}${synthetic ? ' · synthetic sensors on' : ''}`);
  return {
    port: server.address().port,
    db,
    async close() {
      if (timer) clearInterval(timer);
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().catch((e) => {
    console.error('Failed to start:', e.message);
    process.exit(1);
  });
}
