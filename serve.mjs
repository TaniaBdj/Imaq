// Local development entry point (same server as production): `node serve.mjs [port]`
import { startServer } from './server/index.mjs';

startServer({ port: Number(process.argv[2] || process.env.PORT || 8080) }).catch((e) => {
  console.error('Failed to start:', e.message);
  process.exit(1);
});
