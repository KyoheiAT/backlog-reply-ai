import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../backlog-credentials.js', import.meta.url), 'utf8');
const context = vm.createContext({URL});
vm.runInContext(source, context);
const api = context.BacklogCredentials;
const plain = value => JSON.parse(JSON.stringify(value));
const origin = 'https://example.backlog.com';
const other = 'https://other.backlog.jp';
const key = (id, apiKey, label = id) => ({id, apiKey, label});

test('credentials accept only explicit supported HTTPS space origins', () => {
  for (const domain of ['backlog.com', 'backlog.jp', 'backlogtool.com']) {
    assert.equal(api.spaceOrigin(`  https://EXAMPLE.${domain}/  `), `https://example.${domain}`);
  }
  for (const input of ['', null, {}, 'http://example.backlog.com', 'https://example.backlog.com:443',
    'https://example.backlog.com/view/TEST-1', 'https://example.backlog.com?', 'https://example.backlog.com#',
    'https://example.backlog.com/?apiKey=secret', 'https://example.backlog.com.evil.test',
    'https://example.backlog.com@other.backlog.com', 'https://example.backlog.com\\@other.backlog.com']) {
    assert.equal(api.spaceOrigin(input), '', String(input));
  }
});

test('legacy settings retain their credential until a registry is saved', () => {
  const settings = {backlogSpaceUrl: `${origin}/`, backlogKey: ' old-key '};
  assert.deepEqual(plain(api.list(settings)), [{origin, keys: [key('legacy', 'old-key', '既存のAPIキー')], activeKeyId: 'legacy'}]);
  assert.deepEqual(plain(api.resolve(settings)), {origin, apiKey: 'old-key', keyId: 'legacy', label: '既存のAPIキー'});
  assert.equal(api.resolve(settings, other), null);
  assert.equal(api.resolve({...settings, backlogKey: ''}), null);
  assert.equal(api.resolve({...settings, backlogSpaceUrl: 'https://evil.test'}), null);
});

test('the registry is authoritative even when empty or invalid entries are removed', () => {
  for (const backlogSpaces of [[], [null, {}, {origin, keys: []}], [{origin: 'https://evil.test', keys: [key('one', 'secret')]}]]) {
    const settings = {backlogSpaces, backlogSpaceUrl: origin, backlogKey: 'must-not-use-legacy'};
    assert.deepEqual(plain(api.list(settings)), []);
    assert.equal(api.resolve(settings), null);
    assert.equal(api.resolve(settings, origin), null);
  }
});

test('each registered origin resolves only its own selected key', () => {
  const settings = {backlogSpaces: [
    {origin, keys: [key('personal', 'first'), key('work', 'second')], activeKeyId: 'work'},
    {origin: other, keys: [key('personal', 'third')], activeKeyId: 'personal'}
  ]};
  assert.deepEqual(plain(api.resolve(settings)), {origin, apiKey: 'second', keyId: 'work', label: 'work'});
  assert.equal(api.resolve(settings, other).apiKey, 'third');
  for (const invalid of ['', null, 'https://missing.backlog.com', `${origin}/view/TEST-1`, 'https://evil.test']) {
    assert.equal(api.resolve(settings, invalid), null);
  }
  settings.backlogSpaces[0].activeKeyId = 'personal';
  assert.equal(api.resolve(settings, origin).apiKey, 'first');
  settings.backlogSpaces[0].activeKeyId = 'removed';
  assert.equal(api.resolve(settings, origin).apiKey, 'first');
});

test('normalization merges origins and gives malformed or duplicate IDs stable unique replacements', () => {
  const settings = {backlogSpaces: [
    {origin: `${origin}/`, keys: [key('same', 'first'), key('same', 'second'), {apiKey: 'third'},
      key('empty', ' '), key('control', 'key\nvalue'), null]},
    {origin: origin.toUpperCase(), keys: [key('third-key', 'third'), key('fourth-key', 'fourth')], activeKeyId: 'fourth-key'},
    {origin: other, keys: [key('same', 'fifth', '   ')]}
  ]};
  const normalized = plain(api.list(settings));
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].keys.length, 4);
  assert.equal(new Set(normalized[0].keys.map(key => key.id)).size, 4);
  assert.equal(normalized[0].keys[0].id, 'same');
  assert.equal(normalized[0].activeKeyId, 'fourth-key');
  assert.equal(normalized[1].keys[0].label, 'APIキー 1');
  assert.deepEqual(plain(api.list(settings)), normalized);
  assert.deepEqual(plain(api.list({backlogSpaces: normalized})), normalized);
  normalized[0].keys[0].apiKey = 'mutated-copy';
  assert.equal(api.resolve(settings, origin).apiKey, 'fourth');
  assert.equal(settings.backlogSpaces[0].keys[0].apiKey, 'first');
});

test('duplicate maximum-length IDs stay valid and preserve the selected key after normalization', () => {
  const id = 'a'.repeat(128);
  const normalized = plain(api.list({backlogSpaces: [{origin, keys: [
    key(id, 'first'), key(id, 'second'), key(id, 'third')
  ], activeKeyId: id}]}));
  assert.equal(new Set(normalized[0].keys.map(key => key.id)).size, 3);
  assert.ok(normalized[0].keys.every(key => key.id.length <= 128));
  normalized[0].activeKeyId = normalized[0].keys[1].id;
  const settings = {backlogSpaces: normalized};
  assert.equal(api.resolve(settings, origin).apiKey, 'second');
  const again = plain(api.list(settings));
  assert.deepEqual(again, normalized);
  assert.deepEqual(plain(api.list({backlogSpaces: again})), normalized);
  assert.equal(api.resolve({backlogSpaces: again}, origin).apiKey, 'second');
});
