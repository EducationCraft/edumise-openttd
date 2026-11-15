// node --test educraft/brana.test.js — ciste funkce brany (druha mapa tridy, educraft-wallet#1).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const b = require('./brana.js');

test('stavTridy: one map = session, two maps = most active', () => {
  assert.strictEqual(b.stavTridy({ session: 'running' }), 'running');
  assert.strictEqual(b.stavTridy({ session: 'stopped', maps: [{ map: 'A', session: 'stopped' }] }), 'stopped');
  const dve = (a, c) => ({ session: a, maps: [{ map: 'A', session: a }, { map: 'B', session: c }] });
  assert.strictEqual(b.stavTridy(dve('stopped', 'running')), 'running');
  assert.strictEqual(b.stavTridy(dve('running', 'limit')), 'limit');
  assert.strictEqual(b.stavTridy(dve('starting', 'stopped')), 'starting');
  assert.strictEqual(b.stavTridy(dve('stopped', 'stopped')), 'stopped');
});

test('vysledekStartu waits for every map', () => {
  assert.strictEqual(b.vysledekStartu(['running']), 'bezi');
  assert.strictEqual(b.vysledekStartu(['running', 'starting']), null);
  assert.strictEqual(b.vysledekStartu(['running', 'limit']), 'bezi');
  assert.strictEqual(b.vysledekStartu(['running', 'stopped']), 'chyba');
  assert.strictEqual(b.vysledekStartu([null]), null);
});

test('hodinaZaka: auto-join own map, sibling map does not block it', () => {
  const a = { classId: 'c1', gameKey: 'ka', map: 'A', className: '2.A', own: true };
  const s = { classId: 'c1', gameKey: 'kb', map: 'B', className: '2.A', own: false };
  const cizi = { classId: 'c2', gameKey: 'kc', map: 'A', className: '3.B', own: false };
  assert.strictEqual(b.hodinaZaka([a]), a);
  assert.strictEqual(b.hodinaZaka([s, a]), a);
  assert.strictEqual(b.hodinaZaka([a, cizi]), null);
  assert.strictEqual(b.hodinaZaka([s]), null);
  assert.strictEqual(b.hodinaZaka([cizi]), null);
});

test('popisHodiny: two maps of one class never share a label', () => {
  const a = { classId: 'c1', map: 'A', className: '2.A', own: true };
  const s = { classId: 'c1', map: 'B', className: '2.A', own: false };
  const cizi = { classId: 'c2', map: 'A', className: '3.B', own: false };
  assert.strictEqual(b.popisHodiny(cizi, [cizi]), 'Dívat se – 3.B');
  assert.strictEqual(b.popisHodiny(a, [a, s]), 'Hrát – 2.A (mapa A)');
  assert.strictEqual(b.popisHodiny(s, [a, s]), 'Dívat se – 2.A (mapa B)');
});

test('stavMapy, textPresunu, uMapy', () => {
  assert.strictEqual(b.stavMapy('2.A', { map: 'B', session: 'stopped', pupils: 4, resetPending: true }),
    '2.A – mapa B: neběží, žáků 4, nový svět čeká na spuštění');
  assert.strictEqual(b.textPresunu({ status: 409, error: 'pupil_has_company' }), 'Žák je v týmu, který už má firmu – přesunout ho nejde.');
  assert.strictEqual(b.textPresunu({ status: 403 }), 'Žáky této třídy nemůžete přesouvat.');
  assert.strictEqual(b.uMapy({ info: { error: 'x', map: 'B' } }, 'Chyba.'), 'Mapa B: Chyba.');
  assert.strictEqual(b.uMapy({ status: 0 }, 'Chyba.'), 'Chyba.');
});
