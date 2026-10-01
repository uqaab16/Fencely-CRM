import test from 'node:test';
import assert from 'node:assert';

process.env.JWT_SECRET = 'test-secret-not-a-real-one';

const auth = await import('../src/auth.js');

test('JWT sign/verify round trip', () => {
  const token = auth.signToken({ sub: 'admin@example.test', email: 'admin@example.test' });
  const payload = auth.verifyToken(token);
  assert.equal(payload.email, 'admin@example.test');
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));
});

test('JWT rejects tampered and expired tokens', () => {
  const token = auth.signToken({ email: 'admin@example.test' });
  const [h, , s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ email: 'attacker@example.test', exp: 9999999999 })).toString('base64url')}.${s}`;
  assert.equal(auth.verifyToken(forged), null);
  assert.equal(auth.verifyToken('not-a-token'), null);
  assert.equal(auth.verifyToken(token, 'a-different-secret'), null);
});

test('MCP + cron guards fail closed without env secrets', () => {
  delete process.env.MCP_TOKEN;
  delete process.env.CRON_SECRET;
  const req = { headers: { authorization: 'Bearer anything' } };
  assert.equal(auth.checkMcpToken(req), false);
  assert.equal(auth.checkCronAuth(req), false);
});
