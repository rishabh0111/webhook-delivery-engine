'use strict';

const fs = require('fs');
const http = require('http');

// Benchmark receiver: the subscriber endpoint the engine delivers to during a
// benchmark. It accepts everything with a 200 and appends one NDJSON line per
// delivery — { id, t } where id is X-Webhook-Id (the event id) and t is the
// wall-clock ms at which the 2xx was sent. Duplicates are recorded, never
// collapsed, so the analysis can count double-sends.
//
// Runs as its own process (forked by bench/lib.js) so the load generator's
// event loop can't delay the receiver's timestamps.
//
//   node bench/receiver.js <out.ndjson> <port>
const [outFile, portArg] = process.argv.slice(2);
const port = Number(portArg) || 4000;
const out = fs.createWriteStream(outFile, { flags: 'a' });

let received = 0;

const server = http.createServer((req, res) => {
  // Drain the body so the connection can be reused; the bytes aren't checked.
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    received += 1;
    out.write(`${JSON.stringify({ id: req.headers['x-webhook-id'] || null, t: Date.now() })}\n`);
  });
});

// Enough keep-alive headroom for the worker's pooled connections.
server.keepAliveTimeout = 30000;

server.listen(port, '127.0.0.1', () => {
  if (process.send) process.send({ ready: true, port });
});

// The parent asks for a flush + count before it reads the file.
process.on('message', (msg) => {
  if (msg && msg.cmd === 'flush') {
    out.write('', () => process.send({ flushed: true, received }));
  } else if (msg && msg.cmd === 'stop') {
    server.close();
    out.end(() => process.exit(0));
  }
});
