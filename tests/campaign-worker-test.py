"""Offline worker crash/retry tests. No network or real WhatsApp sends."""
import importlib.util
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sender', Path(__file__).resolve().parents[1] / 'integrations/wa-akg/campaign-worker.py')
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)

class WorkerTests(unittest.TestCase):
    def test_buttons_and_single_attempt(self):
        calls = []
        def request(url, body, headers):
            calls.append((url, body))
            raise TimeoutError()
        p = {'number': '61412345678', 'message': 'Reviewed', 'expires_at': time.time() * 1000 + 10000}
        self.assertEqual(sender.send_once(p, 'key', 'session', request), {'status': 'uncertain'})
        self.assertEqual(len(calls), 1)
        self.assertEqual([b['id'] for b in calls[0][1]['buttons']], ['interested', 'stop'])
        self.assertEqual(calls[0][1]['footer'], '')

    def test_expired_permit_never_calls_gateway(self):
        with patch.object(sender, 'post') as network:
            self.assertEqual(sender.send_once({'expires_at': 0}, 'key', 'session'), {'status': 'uncertain'})
            network.assert_not_called()

    def test_restart_acknowledges_only_and_retains_receipt_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / 'receipt.json'
            sender.write_receipt(journal, {'id': 'job', 'token': 'token', 'status': 'uncertain'})
            with patch.object(sender, 'post', side_effect=TimeoutError()) as network:
                with self.assertRaises(TimeoutError):
                    sender.tick('https://crm.example', {}, 'key', 'session', journal)
                self.assertTrue(journal.exists())
                self.assertEqual(network.call_count, 1)
                self.assertTrue(network.call_args.args[0].endswith('/sender/result'))
            with patch.object(sender, 'post', return_value={'ok': True}) as network:
                sender.tick('https://crm.example', {}, 'key', 'session', journal)
                self.assertFalse(journal.exists())
                self.assertEqual(network.call_count, 1)

    def test_crash_after_permit_is_never_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / 'receipt.json'
            replies = [{'job': {'id': 'j', 'token': 't', 'number': '61412345678'}},
                       {'send': True, 'expires_at': time.time() * 1000 + 10000}]
            with patch.object(sender, 'post', side_effect=replies), patch.object(sender, 'registration', return_value='available'), patch.object(sender, 'send_once', side_effect=KeyboardInterrupt()):
                with self.assertRaises(KeyboardInterrupt):
                    sender.tick('https://crm.example', {}, 'key', 'session', journal)
            self.assertTrue(journal.exists())
            with patch.object(sender, 'post', return_value={'ok': True}) as network, patch.object(sender, 'send_once') as send:
                sender.tick('https://crm.example', {}, 'key', 'session', journal)
                send.assert_not_called()
                self.assertTrue(network.call_args.args[0].endswith('/sender/result'))

if __name__ == '__main__':
    unittest.main()
