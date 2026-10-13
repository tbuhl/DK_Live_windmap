"""Local server for DK WIND // God's Eye.

Serves the static app and a tiny caching proxy for Energi Data Service (Energinet).
Energinet's API answers browser requests (any request carrying an Origin header) with an empty
response and no CORS headers, so the browser cannot call it directly; server-side calls work fine.
The proxy also keeps us well inside Energinet's rate limits (responses are cached briefly and
upstream calls are spaced out).

    python serve.py [port] [--no-open]
"""
import functools, http.server, json, os, pathlib, socketserver, sys, threading, time, urllib.error, urllib.parse, urllib.request, webbrowser

HOSTED = 'PORT' in os.environ                      # Render, Railway, Fly, Hugging Face Spaces ... set $PORT and expect 0.0.0.0
PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), int(os.environ.get('PORT', 8765)))
HOST = os.environ.get('HOST', '0.0.0.0' if HOSTED else '127.0.0.1')
ROOT = pathlib.Path(__file__).resolve().parent
UPSTREAM = "https://api.energidataservice.dk/dataset/"
ALLOWED = {"PowerSystemRightNow": 25, "DayAheadPrices": 180, "ImbalancePrice": 60}   # dataset → cache seconds
_cache, _lock, _last = {}, threading.Lock(), [0.0]


def eds(dataset: str, query: str):
    key = dataset + "?" + query
    ttl = ALLOWED[dataset]
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return 200, hit[1]
        wait = 0.45 - (time.time() - _last[0])           # space upstream calls
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(UPSTREAM + dataset + ("?" + query if query else ""), headers={"User-Agent": "dk-wind-godseye/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
            _cache[key] = (time.time(), body)
            return 200, body
        except urllib.error.HTTPError as e:
            if hit:                                      # serve stale rather than fail
                return 200, hit[1]
            return e.code, json.dumps({"error": f"upstream HTTP {e.code}"}).encode()
        except Exception as e:                           # noqa: BLE001
            if hit:
                return 200, hit[1]
            return 502, json.dumps({"error": str(e)}).encode()
        finally:
            _last[0] = time.time()


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/eds/"):
            parsed = urllib.parse.urlsplit(self.path)
            dataset = parsed.path[len("/eds/"):]
            if dataset not in ALLOWED:
                self.send_error(404, "dataset not proxied")
                return
            code, body = eds(dataset, parsed.query)
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
if __name__ == "__main__":
    with socketserver.ThreadingTCPServer((HOST, PORT), functools.partial(Handler, directory=str(ROOT))) as srv:
        url = f"http://{'127.0.0.1' if HOST == '127.0.0.1' else HOST}:{PORT}/"
        print(f"DK WIND on {url}   (Ctrl+C to stop)", flush=True)
        if "--no-open" not in sys.argv and not HOSTED:
            webbrowser.open(url)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
