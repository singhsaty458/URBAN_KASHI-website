import 'dotenv/config';
import { createApp } from './app.js';

process.umask(0o077);
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const host = process.env.HOST || '127.0.0.1';
const app = createApp({ uploadsPath: process.env.UPLOADS_PATH || undefined });
const server = app.listen(port, host, () => {
  console.info(`URBAN KASHI listening on http://${host}:${port}`);
});
server.on('error', () => {
  console.error('Unable to start the HTTP server. Check its host and port configuration.');
  app.locals.closeDatabase();
  process.exitCode = 1;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => { app.locals.closeDatabase(); });
  server.closeIdleConnections();
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    app.locals.closeDatabase();
    process.exit(0);
  }, 10_000);
  deadline.unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);