#!/usr/bin/env python3
"""A deliberately slow origin with a bounded number of workers.

This is the target for the leg of the e2e suite that must prove the emergency brake actually aborts a run.
Nothing else in the suite can prove it: `brakeTripped()` is unit-tested against synthetic metric trees, and
the fast nginx leg asserts the opposite case (that a healthy target does *not* trip it). A brake that
stopped firing would stay silent until the outage it exists to cut short.

    SLOW_MS       milliseconds of work per request (default 250)
    SLOW_WORKERS  how many requests can be served at once (default 1)
    PORT          port to listen on (default 80)

Why threaded accept + a semaphore, rather than a single-threaded server: a single-threaded
`HTTPServer` speaking HTTP/1.1 stays inside one keep-alive connection and does not return to `accept()`,
so everything else waits for that client to go away. That is head-of-line blocking of the whole server,
not a queue — the latency it produces is an artefact, and the run would abort for the wrong reason.

Accepting freely and serialising the *work* is the real shape: a reverse proxy takes the connections, a
bounded pool of application workers does the rendering, and offering more requests per second than
`workers / delay` makes a queue whose wait time grows with utilisation. That is precisely the collapse
crowdsim exists to find, so the test target should collapse the same way.

Everything answers 200 with a small body, so any pool resolves. It logs nothing: at a few hundred requests
a second the logging would become the bottleneck being measured.
"""

import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DELAY = float(os.environ.get("SLOW_MS", "250")) / 1000.0
WORKERS = int(os.environ.get("SLOW_WORKERS", "1"))
BODY = b"<html><body>crowdsim slow origin</body></html>\n"

# The queue. Connections are accepted immediately; only the work is rationed.
WORK = threading.BoundedSemaphore(WORKERS)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"          # keep-alive, like a browser and like k6 by default

    def do_GET(self):
        with WORK:
            time.sleep(DELAY)
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(BODY)))
        # Declared so the cache classification has something to read on this leg too.
        self.send_header("X-Proxy-Cache", "MISS")
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "80"))), Handler)
    server.daemon_threads = True
    server.serve_forever()
