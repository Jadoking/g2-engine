// Serve a built demo over loopback HTTP and record its telemetry.
// Usage: node scripts/serve-demo.ts <dir> <port> [telemetry.jsonl]
// Put an HTTPS proxy you trust in front of it to reach a phone; it binds 127.0.0.1 only.
// POST /telemetry appends one JSON line per request to the telemetry file.

import { createServer } from 'node:http';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const [dirArg, portArg, telemetryArg = 'artifacts/telemetry.jsonl'] = process.argv.slice(2);
if (!dirArg || !portArg) {
  console.error('usage: node scripts/serve-demo.ts <dir> <port> [telemetry.jsonl]');
  process.exit(2);
}
const root = resolve(dirArg);
const port = Number(portArg);
const MAX_BODY = 8 * 1024;
const MAX_LOG = 20 * 1024 * 1024;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function logSize(): number {
  try {
    return statSync(telemetryArg).size;
  } catch {
    return 0;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/telemetry') {
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) tooLarge = true;
    });
    req.on('end', () => {
      if (tooLarge || logSize() > MAX_LOG) return void res.writeHead(413).end();
      try {
        const event = JSON.parse(body);
        const line = JSON.stringify({ received: Date.now(), ...event });
        appendFileSync(telemetryArg, line + '\n');
        console.log(line);
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
  const path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) return void res.writeHead(403).end();
  let file = path;
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    const data = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404).end();
  }
});

server.listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}/, telemetry -> ${telemetryArg}`));
