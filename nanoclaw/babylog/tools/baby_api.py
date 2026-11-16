#!/usr/bin/env python3
"""Client for the Newborn Journal Apps Script API. Uses the standard library only.

Usage:
  baby_api.py connect '<exec url>' '<sheet url>'      # test the connection, then save url + sheet
  baby_api.py status                                   # is it connected? (never prints a key)
  baby_api.py <action> ['<json payload>']              # meta | log | append | tail | query |
                                                       # update | void | summary

Examples:
  baby_api.py tail '{"tab": "feed-log", "n": 3}'
  baby_api.py summary '{"date": "2026-11-15"}'

API key
  Recommended: store it in OneCLI (see docs/SETUP.md). The gateway adds ?key=<API key> to every
  request to script.google.com on the way out, so this script and the agent never see the key.
  Fallback (no OneCLI): put "token" in baby_api.json and it's sent in the request body.

Config: baby_api.json next to this script, {"url": "<exec url>", "sheet": "<sheet url>"}
plus an optional "token". The BABY_API_URL and BABY_SHEET_URL environment variables override it.
Prints the API's JSON response. Exits with code 1 if the response has "ok": false.
"""
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = Path(os.environ.get("BABY_API_CONFIG", Path(__file__).with_name("baby_api.json")))
EXEC_RE = re.compile(r"^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$")
SHEET_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9_-]{20,})")
ACTIONS = {"meta", "log", "append", "tail", "query", "update", "void", "summary"}
PLACEHOLDERS = {"", "onecli-managed", "gateway-managed"}


def _ssl_context():
    """Trust the system CAs, plus any CA bundle the container's proxy gateway provides."""
    ctx = ssl.create_default_context()
    for var in ("NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "CURL_CA_BUNDLE"):
        path = os.environ.get(var)
        if path and os.path.isfile(path):
            try:
                ctx.load_verify_locations(cafile=path)
            except ssl.SSLError:
                pass
    return ctx


OPENER = urllib.request.build_opener(urllib.request.HTTPSHandler(context=_ssl_context()))


def fail(msg):
    print(json.dumps({"ok": False, "error": "client", "message": msg}))
    sys.exit(1)


def load_config():
    cfg = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
    cfg = {
        "url": os.environ.get("BABY_API_URL") or cfg.get("url"),
        "sheet": os.environ.get("BABY_SHEET_URL") or cfg.get("sheet"),
        "token": cfg.get("token"),  # optional: only when OneCLI isn't used
    }
    missing = [k for k in ("url", "sheet") if not cfg[k]]
    if missing:
        fail(f"Not connected (missing {', '.join(missing)}). Ask the user to send: "
             "/babysheet <exec url> <sheet url>")
    return cfg


def call(cfg, action, payload=None):
    body = dict(payload or {})
    body.pop("token", None)
    body.update(sheet=cfg["sheet"], action=action)
    if (cfg.get("token") or "") not in PLACEHOLDERS:
        body["token"] = cfg["token"]
    req = urllib.request.Request(
        cfg["url"],  # no key in the URL: OneCLI appends ?key=... in transit
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # Apps Script answers a POST with a 302. urllib follows it as a GET, which is what Apps Script expects.
    # HTTPS_PROXY (nanoclaw's OneCLI gateway) is picked up from the environment automatically.
    try:
        with OPENER.open(req, timeout=60) as resp:
            text = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        fail(f"HTTP {e.code} from the API. Check the exec URL and that the deployment's access is 'Anyone'.")
    except urllib.error.URLError as e:
        fail(f"Could not reach the API: {e.reason}")
    try:
        res = json.loads(text)
    except json.JSONDecodeError:
        fail("The API returned a page, not JSON. The usual causes: the deployment's access isn't 'Anyone', "
             "or the URL is the /dev test URL, not /exec.")
    if res.get("error") == "unauthorized" and (cfg.get("token") or "") in PLACEHOLDERS:
        res["hint"] = ("No key reached the API. Check that the OneCLI secret exists (host pattern "
                       "script.google.com, --param-name key) and is granted to this agent.")
    return res


def connect(url, sheet, token=None):
    url, sheet = url.strip(), sheet.strip()
    if not EXEC_RE.match(url):
        fail("The exec URL should look like https://script.google.com/macros/s/<id>/exec")
    if not SHEET_RE.search(sheet):
        fail("The sheet URL should look like https://docs.google.com/spreadsheets/d/<id>/edit")
    cfg = {"url": url, "sheet": sheet}
    if token:
        cfg["token"] = token.strip()
    elif CONFIG.exists():
        old = json.loads(CONFIG.read_text()).get("token")
        if old:
            cfg["token"] = old  # keep a fallback key that was already set on the host
    res = call(cfg, "meta")
    if not res.get("ok"):
        print(json.dumps(res))
        sys.exit(1)
    CONFIG.write_text(json.dumps(cfg))
    os.chmod(CONFIG, 0o600)
    print(json.dumps({"ok": True, "connected": res["result"]["title"],
                      "timezone": res["result"]["timezone"],
                      "key_source": "config file" if cfg.get("token") else "OneCLI"}))


def main():
    if len(sys.argv) < 2:
        fail(__doc__)
    cmd = sys.argv[1]
    if cmd == "connect":
        if len(sys.argv) not in (4, 5):
            fail("Usage: connect '<exec url>' '<sheet url>'")
        connect(*sys.argv[2:5])
        return
    if cmd == "status":
        cfg = load_config()
        res = call(cfg, "meta")
        print(json.dumps({"ok": res.get("ok", False),
                          "sheet": (res.get("result") or {}).get("title"),
                          "key_source": "config file" if (cfg.get("token") or "") not in PLACEHOLDERS else "OneCLI",
                          "error": res.get("error"), "hint": res.get("hint")}))
        sys.exit(0 if res.get("ok") else 1)
    if cmd not in ACTIONS:
        fail(f"Unknown action '{cmd}'. Use one of: {', '.join(sorted(ACTIONS))}")
    payload = {}
    if len(sys.argv) > 2:
        try:
            payload = json.loads(sys.argv[2])
        except json.JSONDecodeError as e:
            fail(f"Payload is not valid JSON: {e}")
    res = call(load_config(), cmd, payload)
    print(json.dumps(res, ensure_ascii=False))
    sys.exit(0 if res.get("ok") else 1)


if __name__ == "__main__":
    main()
