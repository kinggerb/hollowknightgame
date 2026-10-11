#!/usr/bin/env node
/**
 * Tests for the Hollow Knight save-file codec (hk-save-codec.js) and the
 * save import/export in ipad.html — including .dat.html editor downloads
 * such as the ones hollowedit.com produces (Safari renames user1.dat to
 * user1.dat.html when saving).
 *
 * The AES/container code is checked against tools/fixtures/*, which were
 * generated with a reference implementation (pycryptodome), so a bug in the
 * JS crypto cannot pass unnoticed. The page-level tests run ipad.html in
 * jsdom with a fake IndexedDB and a stubbed Unity loader.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const codecCode = await readFile(path.join(here, '..', 'hk-save-codec.js'), 'utf8');
const ipadHtml = await readFile(path.join(here, '..', 'ipad.html'), 'utf8');

const fixtureJson = await readFile(path.join(here, 'fixtures', 'save-small.json'), 'utf8');
const fixtureDat = new Uint8Array(await readFile(path.join(here, 'fixtures', 'save-small.dat')));
const fixtureBadpad = new Uint8Array(await readFile(path.join(here, 'fixtures', 'save-small-badpad.dat')));
const aesVectors = JSON.parse(await readFile(path.join(here, 'fixtures', 'aes-vectors.json'), 'utf8'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => Buffer.from(b).toString('hex');

function loadCodec() {
  const sandbox = {};
  new Function('globalThis', codecCode)(sandbox);
  return sandbox.HKSaveCodec;
}

/* ---------------------------------------------------------------------- */
/* fake IndexedDB (enough for the page's save import/export paths)         */
/* ---------------------------------------------------------------------- */

function makeFakeIDB() {
  const FILE_DATA = new Map();

  function FakeRequest() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
  FakeRequest.prototype.fire = function () {
    const req = this;
    queueMicrotask(() => {
      if (req.onsuccess) req.onsuccess({ target: req });
    });
  };

  function open() {
    const req = new FakeRequest();
    const db = {
      objectStoreNames: { contains: (name) => name === 'FILE_DATA' },
      transaction(name, mode) {
        assert.equal(name, 'FILE_DATA');
        const ops = [];
        const store = {
          getAllKeys() {
            const r = new FakeRequest();
            r.result = [...FILE_DATA.keys()];
            r.fire();
            return r;
          },
          getAll() {
            const r = new FakeRequest();
            r.result = [...FILE_DATA.values()];
            r.fire();
            return r;
          },
          get(key) {
            const r = new FakeRequest();
            r.result = FILE_DATA.get(String(key));
            r.fire();
            return r;
          },
          put(value, key) {
            ops.push(() => FILE_DATA.set(String(key), value));
            const r = new FakeRequest();
            r.fire();
            return r;
          },
          delete(key) {
            ops.push(() => FILE_DATA.delete(String(key)));
            const r = new FakeRequest();
            r.fire();
            return r;
          },
        };
        const tx = {
          mode,
          objectStore: () => store,
          oncomplete: null,
          onerror: null,
          onblocked: null,
        };
        // settle after every request handler queued so far has run
        setTimeout(() => {
          ops.forEach((op) => op());
          if (tx.oncomplete) tx.oncomplete({ target: tx });
        }, 0);
        return tx;
      },
    };
    req.result = db;
    req.fire();
    return req;
  }

  return { open, FILE_DATA };
}

/* ---------------------------------------------------------------------- */
/* jsdom page helper                                                       */
/* ---------------------------------------------------------------------- */

async function createPage({ idb = true } = {}) {
  const jsdomErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => jsdomErrors.push(String(e && e.message || e)));
  const downloads = [];
  const dom = new JSDOM(ipadHtml, {
    url: 'https://hk.test/ipad.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.eval(codecCode); // jsdom does not fetch <script src> without resources:'usable'
      if (idb) window.indexedDB = makeFakeIDB();
      window.fetch = async () => ({ ok: true, status: 200 });
      window.URL.createObjectURL = (blob) => {
        downloads.push({ blob });
        return 'blob:test-' + downloads.length;
      };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () {
        const current = downloads[downloads.length - 1];
        if (current) current.download = this.getAttribute('download');
      };
      window.HKStream = {
        VERSION: 'test',
        detect: async () => ({
          opfs: false, quota: 0, usage: 0, available: 0, secure: true, workers: false,
        }),
      };
    },
  });
  await sleep(5);
  assert.equal(jsdomErrors.length, 0, `page should boot without script errors: ${jsdomErrors.join('; ')}`);
  return { dom, window: dom.window, downloads, jsdomErrors };
}

async function importFile(window, name, bytes) {
  const file = new window.File([bytes], name);
  const input = window.document.getElementById('saveFile');
  Object.defineProperty(input, 'files', { configurable: true, value: { 0: file, length: 1 } });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  input.value = '';
  await sleep(20); // FileReader + microtasks + the fake IDB's tx timer
  return window.document.getElementById('toast').textContent;
}

/* ---------------------------------------------------------------------- */

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

/* codec: AES-256-ECB against reference vectors */

test('AES-256-ECB matches the reference vectors (both directions)', () => {
  const codec = loadCodec();
  for (const v of aesVectors) {
    const plain = hexToBytes(v.plain);
    const cipher = hexToBytes(v.cipher);
    assert.equal(bytesToHex(codec._internals.ecbEncrypt(plain)), v.cipher);
    assert.equal(bytesToHex(codec._internals.ecbDecrypt(cipher)), v.plain);
  }
});

test('decodeDat reads the reference .dat container exactly', () => {
  const codec = loadCodec();
  assert.equal(codec.decodeDat(fixtureDat), fixtureJson);
  assert.equal(codec.looksLikeDat(fixtureDat), true);
});

test('encodeDat reproduces the reference container byte for byte', () => {
  const codec = loadCodec();
  assert.deepEqual(Buffer.from(codec.encodeDat(fixtureJson)), Buffer.from(fixtureDat));
});

test('encodeDat/decodeDat round-trips a multi-byte length header', () => {
  const codec = loadCodec();
  // base64 payload > 128 bytes needs a 2+ byte length-prefixed string
  const big = JSON.stringify({ version: 1, playerData: { pad: 'x'.repeat(20000) } });
  const dat = codec.encodeDat(big);
  assert.equal(codec.decodeDat(dat), big);
});

test('containers with broken pkcs7 padding are still recovered', () => {
  // hollowedit.com shipped a padding bug at one point; this fixture pads the
  // payload with zero bytes instead of the pad-length byte
  const codec = loadCodec();
  assert.equal(codec.decodeDat(fixtureBadpad), fixtureJson);
  assert.equal(codec.findSave(fixtureBadpad), fixtureJson);
});

test('findSave accepts .dat bytes, plain JSON, bare base64 and HTML wrappers', () => {
  const codec = loadCodec();
  const asLatin1 = (b) => Buffer.from(b).toString('latin1');
  const b64 = Buffer.from(fixtureDat.subarray(22, fixtureDat.length - 1)).toString('latin1');

  assert.equal(codec.findSave(fixtureDat), fixtureJson);
  assert.equal(codec.findSave(new TextEncoder().encode(fixtureJson)), fixtureJson);
  assert.equal(codec.findSave(new TextEncoder().encode(b64)), fixtureJson);
  assert.equal(
    codec.findSave(new TextEncoder().encode('<html><body>' + asLatin1(fixtureDat) + '</body></html>')),
    fixtureJson
  );
  assert.equal(
    codec.findSave(new TextEncoder().encode('garbage prefix ' + b64 + ' trailing garbage')),
    fixtureJson
  );
});

test('findSave rejects things that are not saves', () => {
  const codec = loadCodec();
  for (const junk of [
    '<html><body>hello</body></html>',
    JSON.stringify([{ key: '/idbfs/x/user1.dat', value: {} }]),
    '',
  ]) {
    assert.throws(() => codec.findSave(new TextEncoder().encode(junk)));
  }
  assert.throws(() => codec.findSave(new Uint8Array(10)));
});

test('the save file input has no accept filter (iPadOS greys out all files otherwise)', () => {
  const dom = new JSDOM(ipadHtml);
  try {
    const input = dom.window.document.getElementById('saveFile');
    assert.equal(
      input.getAttribute('accept'), null,
      'an accept list with extensions Safari cannot map (.dat.html, .dat) disables ' +
      'every file in the iPadOS picker; contents-based validation is used instead'
    );
  } finally {
    dom.window.close();
  }
});

/* page-level import */

test('importing hollowedit-style user1.dat.html writes the encrypted slot', async () => {
  const { dom, window } = await createPage();
  try {
    const idb = window.indexedDB;
    idb.open('/idbfs'); // fire once so the store exists with a hash key
    await sleep(5);
    idb.FILE_DATA.set('/idbfs/abc123/user4.dat', {
      timestamp: new Date(),
      mode: 33206,
      contents: new Int8Array([1]),
    });
    idb.FILE_DATA.set('/idbfs/abc123/other.file', {
      timestamp: new Date(),
      mode: 33206,
      contents: new Int8Array([2]),
    });

    const toast = await importFile(window, 'user1.dat.html', fixtureDat);
    assert.match(toast, /slot 1/, 'the toast should name the slot');

    const entry = idb.FILE_DATA.get('/idbfs/abc123/user1.dat');
    assert.ok(entry, 'user1.dat should have been written');
    assert.equal(entry.mode, 33206);
    const codec = loadCodec();
    assert.equal(codec.decodeDat(new Uint8Array(entry.contents)), fixtureJson);
    assert.deepEqual(Buffer.from(entry.contents), Buffer.from(fixtureDat), 'validated containers are written as-is');
    assert.equal(idb.FILE_DATA.get('/idbfs/abc123/user4.dat').contents.length, 1, 'other slots are left alone');
    assert.equal(idb.FILE_DATA.get('/idbfs/abc123/other.file').contents.length, 1, 'other files are left alone');
  } finally {
    dom.window.close();
  }
});

test('the slot number is parsed from the file name', async () => {
  const { dom, window } = await createPage();
  try {
    const idb = window.indexedDB;
    idb.open('/idbfs');
    await sleep(5);
    idb.FILE_DATA.set('/idbfs/abc123/user1.dat', {
      timestamp: new Date(),
      mode: 33206,
      contents: new Int8Array([1]),
    });

    const toast = await importFile(window, 'user3.dat.html', fixtureDat);
    assert.match(toast, /slot 3/);
    assert.ok(idb.FILE_DATA.has('/idbfs/abc123/user3.dat'), 'user3.dat should have been written');
    assert.ok(idb.FILE_DATA.has('/idbfs/abc123/user1.dat'), 'user1.dat should be untouched');
  } finally {
    dom.window.close();
  }
});

test('a plain (decrypted) JSON save is encrypted into the game format', async () => {
  const { dom, window } = await createPage();
  try {
    const idb = window.indexedDB;
    idb.open('/idbfs');
    await sleep(5);
    idb.FILE_DATA.set('/idbfs/abc123/user1.dat', {
      timestamp: new Date(),
      mode: 33206,
      contents: new Int8Array([1]),
    });

    const toast = await importFile(window, 'plain.json', new TextEncoder().encode(fixtureJson));
    assert.match(toast, /slot 1/);
    const entry = idb.FILE_DATA.get('/idbfs/abc123/user1.dat');
    const dat = new Uint8Array(entry.contents);
    const codec = loadCodec();
    assert.equal(codec.looksLikeDat(dat), true, 'should be re-packaged as a .dat container');
    assert.equal(dat[dat.length - 1], 0x0b, 'container should end with the 0x0b tail byte');
    assert.equal(codec.decodeDat(dat), fixtureJson);
  } finally {
    dom.window.close();
  }
});

test("this page's hk-save.json export still imports (existing behaviour)", async () => {
  const { dom, window } = await createPage();
  try {
    const idb = window.indexedDB;
    idb.open('/idbfs');
    await sleep(5);
    // seed under the "current" hash first: keys[0] defines it, and the
    // importer drops entries that do not carry that hash
    idb.FILE_DATA.set('/idbfs/abc123/user4.dat', {
      timestamp: new Date(),
      mode: 33206,
      contents: new Int8Array([1]),
    });
    idb.FILE_DATA.set('/idbfs/oldhash/user1.dat', {
      timestamp: '2020-01-01T00:00:00Z',
      mode: 33206,
      contents: new Int8Array([9, 9, 9]),
    });

    const payload = [
      {
        key: '/idbfs/oldhash/user1.dat',
        value: { timestamp: '2024-05-06T07:08:09Z', mode: 33206, contents: { 0: 42, 1: 43 } },
      },
    ];
    const toast = await importFile(window, 'hk-save.json', new TextEncoder().encode(JSON.stringify(payload)));
    assert.match(toast, /Save imported — reload/);
    assert.equal(idb.FILE_DATA.has('/idbfs/oldhash/user1.dat'), false, 'entries from other hashes are dropped');
    const entry = idb.FILE_DATA.get('/idbfs/abc123/user1.dat');
    assert.ok(entry, 'entry should be re-keyed to the current hash');
    assert.deepEqual(Array.from(entry.contents), [42, 43]);
    assert.equal(entry.timestamp.getTime(), Date.parse('2024-05-06T07:08:09Z'));
  } finally {
    dom.window.close();
  }
});

test('a non-save .dat.html is rejected with a clear message and no writes', async () => {
  const { dom, window } = await createPage();
  try {
    const idb = window.indexedDB;
    idb.open('/idbfs');
    await sleep(5);
    idb.FILE_DATA.set('/idbfs/abc123/user1.dat', {
      timestamp: new Date(),
      mode: 33206,
      contents: new Int8Array([1]),
    });
    const before = JSON.stringify([...idb.FILE_DATA.keys()]);

    const toast = await importFile(
      window,
      'user1.dat.html',
      new TextEncoder().encode('<html><body>404 not a save</body></html>')
    );
    assert.match(toast, /Not a Hollow Knight save/);
    assert.equal(JSON.stringify([...idb.FILE_DATA.keys()]), before, 'nothing should be written');
  } finally {
    dom.window.close();
  }
});

test('Export .dat slot downloads the stored slot as userN.dat', async () => {
  const { dom, window, downloads } = await createPage();
  try {
    const idb = window.indexedDB;
    idb.open('/idbfs');
    await sleep(5);
    idb.FILE_DATA.set('/idbfs/abc123/user2.dat', {
      timestamp: new Date(),
      mode: 33206,
      contents: fixtureDat,
    });
    window.prompt = () => '2';

    window.document.getElementById('exportDatBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
    await sleep(20);

    assert.equal(downloads.length, 1, 'one download should be triggered');
    assert.equal(downloads[0].download, 'user2.dat');
    const blobBytes = new Uint8Array(await downloads[0].blob.arrayBuffer());
    assert.deepEqual(Buffer.from(blobBytes), Buffer.from(fixtureDat));
  } finally {
    dom.window.close();
  }
});

/* ---------------------------------------------------------------------- */

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

if (failures) {
  console.error(`\n${failures} of ${tests.length} save import tests failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} save import tests passed`);
}
