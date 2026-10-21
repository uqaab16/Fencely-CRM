#!/usr/bin/env python3
"""Private, outbound-only registration worker. Cannot send messages."""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def post(url, body, headers):
    request = urllib.request.Request(url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **headers}, method="POST")
    with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
        return json.load(response)


def verdict(job, gateway_key, session):
    number = job["number"]
    try:
        body = post("http://127.0.0.1:3300/api/chat/" + urllib.parse.quote(session, safe="") + "/check",
            {"numbers": [number]}, {"X-API-Key": gateway_key})
        results = body.get("data", {}).get("results", [])
        result = next((r for r in results if r.get("number") == number), None)
        if body.get("status") is not True or not result or result.get("error"):
            return "check_failed"
        if result.get("exists") is True:
            return "available"
        if result.get("exists") is False:
            return "not_found"
    except Exception:
        pass
    return "check_failed"


def run():
    origin = os.environ.get("CRM_ORIGIN", "").rstrip("/")
    parsed = urllib.parse.urlparse(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise ValueError("CRM_ORIGIN must be an HTTPS origin")
    secret = Path(os.environ.get("WA_BRIDGE_SECRET_FILE", "/opt/fencely-wa/crm-bridge-secret")).read_text().strip()
    key = Path("/opt/fencely-wa/crm-api-key").read_text().strip()
    session = os.environ["WA_AKG_SESSION_ID"]
    if len(secret) < 32 or not key or not session:
        raise ValueError("Worker credentials are missing")
    headers = {"Authorization": "Bearer " + secret}
    pending = None
    while True:
        delay = 60
        try:
            if pending is None:
                job = post(origin + "/api/whatsapp/bridge/claim", {}, headers).get("job")
                if job:
                    pending = {"id": job["id"], "token": job["token"], "number": job["number"],
                               "status": verdict(job, key, session)}
            if pending is not None:
                post(origin + "/api/whatsapp/bridge/result", pending, headers)
                pending = None
                print("Registration check saved", flush=True)
                delay = 5
        except urllib.error.HTTPError as error:
            # Reject old leases without ever logging numbers, keys or bodies.
            if error.code == 409:
                pending = None
            print("CRM HTTP error:", error.code, flush=True)
        except Exception:
            print("Connection unavailable; retrying", flush=True)
        time.sleep(delay)


if __name__ == "__main__":
    run()
