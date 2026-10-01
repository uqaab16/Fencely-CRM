import test from 'node:test';
import assert from 'node:assert';

const config = await import('../src/config.js');

test('config defaults are the current product vocabulary', () => {
  assert.equal(config.APP_NAME, 'Fencely CRM');
  assert.ok(config.NICHES.includes('Colorbond'));
  assert.equal(config.STAGES[0], 'New');
  assert.ok(config.STAGES.includes('Do Not Contact'));
  assert.deepEqual(config.FIT_NICHES, ['Colorbond', 'Timber', 'Pool Fencing', 'Aluminium/Slat']);
});

test('parseJsonEnv: valid override wins, garbage falls back', () => {
  process.env.TEST_NICHES_JSON = '["Decking","Fencing"]';
  assert.deepEqual(config.parseJsonEnv('TEST_NICHES_JSON', ['X']), ['Decking', 'Fencing']);
  process.env.TEST_NICHES_JSON = 'not json';
  assert.deepEqual(config.parseJsonEnv('TEST_NICHES_JSON', ['X']), ['X']);
  process.env.TEST_NICHES_JSON = '{"a":1}';
  assert.deepEqual(config.parseJsonEnv('TEST_NICHES_JSON', ['X']), ['X']);
  process.env.TEST_NICHES_JSON = '[]';
  assert.deepEqual(config.parseJsonEnv('TEST_NICHES_JSON', ['X']), ['X']);
  delete process.env.TEST_NICHES_JSON;
  assert.deepEqual(config.parseJsonEnv('TEST_NICHES_JSON', ['X']), ['X']);
});
