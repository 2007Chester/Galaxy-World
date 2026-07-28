#!/usr/bin/env python3
"""
Chrome DevTools Protocol screenshot + diagnostics harness for the review loop.

Captures the composited page (WebGL canvas *and* the DOM HUD), collects console
errors, and reports live renderer stats from window.__fpsDebug.info().

Usage:
  python3 tools/shoot.py out.png "shot=2&enemies=6" [--w 1600] [--h 900] [--settle 4]

Requires: websocket-client  (python3 -m pip install --user websocket-client)
"""
import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    import websocket  # type: ignore
except ImportError:
    sys.exit("pip install --user websocket-client")

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def find_chrome():
    for c in CHROME_CANDIDATES:
        if os.path.exists(c):
            return c
    w = shutil.which("google-chrome") or shutil.which("chromium")
    if w:
        return w
    sys.exit("No Chrome/Chromium found.")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=45, max_size=64 * 1024 * 1024)
        self.n = 0
        self.events = []

    def send(self, method, params=None, timeout=45):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(max(0.2, deadline - time.time()))
            try:
                msg = json.loads(self.ws.recv())
            except websocket.WebSocketTimeoutException:
                continue
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            self.events.append(msg)
        raise TimeoutError(method)

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            self.ws.settimeout(max(0.05, end - time.time()))
            try:
                self.events.append(json.loads(self.ws.recv()))
            except Exception:
                pass

    def evaluate(self, expr, timeout=45):
        r = self.send(
            "Runtime.evaluate",
            {"expression": expr, "returnByValue": True, "awaitPromise": True},
            timeout=timeout,
        )
        if r.get("exceptionDetails"):
            return {"__exception": r["exceptionDetails"].get("text", "")
                    + " " + str(r["exceptionDetails"].get("exception", {}).get("description", ""))}
        return r.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def collect_logs(cdp):
    out = []
    for ev in cdp.events:
        m = ev.get("method")
        if m == "Runtime.consoleAPICalled":
            t = ev["params"].get("type")
            if t in ("error", "warning", "log", "info"):
                parts = []
                for a in ev["params"].get("args", []):
                    parts.append(str(a.get("value", a.get("description", a.get("unserializableValue", "")))))
                out.append(f"[{t}] " + " ".join(parts)[:600])
        elif m == "Runtime.exceptionThrown":
            d = ev["params"]["exceptionDetails"]
            out.append("[exception] " + (d.get("text", "") + " " +
                       str(d.get("exception", {}).get("description", ""))).strip()[:900])
        elif m == "Log.entryAdded":
            e = ev["params"]["entry"]
            if e.get("level") in ("error", "warning"):
                out.append(f"[{e['level']}] {e.get('text','')} {e.get('url','')}"[:400])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("query", nargs="?", default="shot=0")
    ap.add_argument("--w", type=int, default=1600)
    ap.add_argument("--h", type=int, default=900)
    ap.add_argument("--settle", type=float, default=5.0, help="seconds to let the scene run before capture")
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--eval", default=None, help="extra JS to run right before capture")
    ap.add_argument("--eval-file", default=None, help="path to a JS file to run right before capture")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    url = f"http://127.0.0.1:{args.port}/index.html?{args.query}"

    dbg = free_port()
    profile = tempfile.mkdtemp(prefix="fpsshot-")
    proc = subprocess.Popen(
        [
            find_chrome(),
            "--headless=new",
            f"--remote-debugging-port={dbg}",
            "--remote-allow-origins=*",
            f"--window-size={args.w},{args.h}",
            "--hide-scrollbars",
            "--no-sandbox",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
            "--enable-gpu-rasterization",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--mute-audio",
            "--force-device-scale-factor=1",
            "--autoplay-policy=no-user-gesture-required",
            f"--user-data-dir={profile}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    cdp = None
    info = None
    logs = []
    status = 1
    try:
        # wait for the debugging endpoint
        ws_url = None
        for _ in range(200):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{dbg}/json/version", timeout=1) as r:
                    ws_url = json.load(r)["webSocketDebuggerUrl"]
                break
            except Exception:
                time.sleep(0.15)
        if not ws_url:
            raise RuntimeError("Chrome DevTools endpoint never came up")

        browser = CDP(ws_url)
        target = browser.send("Target.createTarget", {"url": "about:blank"})["targetId"]
        pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{dbg}/json/list", timeout=5))
        page_ws = next(p["webSocketDebuggerUrl"] for p in pages if p["id"] == target)
        browser.close()

        cdp = CDP(page_ws)
        cdp.send("Page.enable")
        cdp.send("Runtime.enable")
        cdp.send("Log.enable")
        cdp.send("Emulation.setDeviceMetricsOverride", {
            "width": args.w, "height": args.h, "deviceScaleFactor": 1, "mobile": False,
        })
        cdp.send("Page.navigate", {"url": url})

        # wait for the game to signal it has rendered a stable run of frames
        ready = False
        deadline = time.time() + 40
        while time.time() < deadline:
            cdp.pump(0.4)
            if cdp.evaluate("!!window.__shotReady", timeout=10) is True:
                ready = True
                break
        if not ready and not args.quiet:
            print("warn: __shotReady never set; capturing anyway")

        cdp.pump(args.settle)

        script = args.eval
        if args.eval_file:
            with open(args.eval_file) as f:
                script = f.read()
        if script:
            res = cdp.evaluate(script, timeout=180)
            if res is not None and not args.quiet:
                print("eval:", json.dumps(res)[:8000])
            cdp.pump(1.2)

        info = cdp.evaluate("JSON.stringify(window.__fpsDebug ? window.__fpsDebug.info() : {no:'debug'})")
        shot = cdp.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        with open(out, "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        logs = collect_logs(cdp)
        status = 0
    except Exception as e:
        print(f"FAIL {e}")
        if cdp:
            logs = collect_logs(cdp)
    finally:
        if cdp:
            cdp.close()
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)

    sidecar = out.rsplit(".", 1)[0] + ".json"
    with open(sidecar, "w") as f:
        json.dump({"url": url, "info": info, "logs": logs}, f, indent=1)

    size = os.path.getsize(out) if os.path.exists(out) else 0
    if not args.quiet:
        print(("OK  " if status == 0 and size > 2000 else "FAIL ") + f"{out} ({size} bytes)")
        if info:
            print("info:", info)
        errs = [l for l in logs if l.startswith(("[error", "[exception"))]
        for l in errs[:25]:
            print(" ", l)
        if not errs and logs and not args.quiet:
            for l in logs[-8:]:
                print(" ", l)
    sys.exit(status if size > 2000 else 1)


if __name__ == "__main__":
    main()
