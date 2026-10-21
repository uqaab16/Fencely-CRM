#!/usr/bin/env python3
"""Outbound-only sender; no automatic retry of a WhatsApp send, even after a crash."""
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

def get(url, headers):
    request = urllib.request.Request(url, headers=headers, method='GET')
    with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
        return json.load(response)

def gateway_status(key, session, request=get):
    try:
        response = request('http://127.0.0.1:3300/api/sessions', {'X-API-Key': key})
        if response.get('status') is not True:
            return 'unknown'
        item = next((s for s in response.get('data', []) if s.get('sessionId') == session), None)
        if not item:
            return 'unknown'
        if item.get('status') == 'CONNECTED':
            return 'connected'
        if item.get('status') in ('DISCONNECTED', 'ZOMBIE'):
            return 'disconnected'
    except Exception:
        pass
    return 'unknown'

def write_receipt(path, receipt):
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(receipt, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

def registration(job, key, session, request=post):
    try:
        body = request('http://127.0.0.1:3300/api/chat/' + urllib.parse.quote(session, safe='') + '/check',
            {'numbers': [job['number']]}, {'X-API-Key': key})
        result = next((r for r in body.get('data', {}).get('results', []) if r.get('number') == job['number']), None)
        if body.get('status') is True and result and not result.get('error'):
            if result.get('exists') is True:
                return 'available'
            if result.get('exists') is False:
                return 'not_found'
    except Exception:
        pass
    return 'check_failed'

def send_once(permit, key, session, request=post):
    # A permit is consumable once. Its ten-second lifetime bounds the pause/STOP race.
    if time.time() * 1000 >= permit['expires_at']:
        return {'status': 'uncertain'}
    payload = {'title': '', 'body': permit['message'], 'footer': '', 'buttons': [
        {'type': 'quick_reply', 'displayText': 'Interested', 'id': 'interested'},
        {'type': 'quick_reply', 'displayText': 'Stop', 'id': 'stop'},
    ]}
    url = 'http://127.0.0.1:3300/api/messages/' + urllib.parse.quote(session, safe='') + '/' + urllib.parse.quote(permit['number'] + '@s.whatsapp.net', safe='') + '/interactive'
    try:
        response = request(url, payload, {'X-API-Key': key})
        message_id = response.get('data', {}).get('key', {}).get('id')
        if response.get('status') is True and isinstance(message_id, str) and message_id:
            return {'status': 'sent', 'message_id': message_id}
    except Exception:
        pass
    return {'status': 'uncertain'}

def tick(origin, headers, key, session, journal):
    if journal.exists():
        receipt = json.loads(journal.read_text())
        # If this fails, keep the durable receipt and retry ONLY the CRM acknowledgement.
        post(origin + '/api/whatsapp/sender/result', receipt, headers)
        journal.unlink()
        return
    job = post(origin + '/api/whatsapp/sender/claim', {}, headers).get('job')
    if not job:
        return
    status = registration(job, key, session)
    receipt = {'id': job['id'], 'token': job['token'], 'status': 'uncertain'}
    # Journal BEFORE authorization: a lost permit response cannot cause a resend.
    write_receipt(journal, receipt)
    permit = post(origin + '/api/whatsapp/sender/authorize', {**job, 'registration': status}, headers)
    if permit.get('send') is not True:
        journal.unlink()
        return
    receipt.update(send_once(permit, key, session))
    write_receipt(journal, receipt)
    post(origin + '/api/whatsapp/sender/result', receipt, headers)
    journal.unlink()

def run():
    origin = os.environ.get('CRM_ORIGIN', '').rstrip('/')
    parsed = urllib.parse.urlparse(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError('CRM_ORIGIN must be an HTTPS origin')
    secret = Path('/opt/fencely-wa/crm-sender-secret').read_text().strip()
    key = Path('/opt/fencely-wa/crm-api-key').read_text().strip()
    session = os.environ['WA_AKG_SESSION_ID']
    if len(secret) < 32 or not key or not session:
        raise ValueError('Sender credentials missing')
    journal = Path('/var/lib/fencely-sender/receipt.json')
    headers = {'Authorization': 'Bearer ' + secret}
    error_code = 'none'
    while True:
        try:
            status = gateway_status(key, session)
            post(origin + '/api/whatsapp/sender/heartbeat', {
                'gateway': status, 'pending': journal.exists(), 'error': error_code,
            }, headers)
            # Always reconcile existing receipts, even with WhatsApp disconnected.
            if journal.exists() or status == 'connected':
                tick(origin, headers, key, session, journal)
            error_code = 'none'
        except urllib.error.HTTPError as error:
            error_code = 'crm_error'
            print('CRM HTTP error:', error.code, flush=True)
        except Exception:
            error_code = 'worker_error'
            print('Sender waiting for connection; no send retry', flush=True)
        time.sleep(60)

if __name__ == '__main__':
    run()
