/* ============================================================================
 * tools/test-hk-stream.mjs — verifies hk-stream.js + hk-writer.js in Node
 * ----------------------------------------------------------------------------
 * Run:  node tools/test-hk-stream.mjs            (full, reads the real ~930 MB)
 *       node tools/test-hk-stream.mjs --quick    (only the small wasm parts)
 *
 * It fakes an Origin Private File System on a temp directory, fakes the HTTP
 * server for the Build/*.partN chunks, and checks that the assembled files are
 * byte-exact, resumable, retry-safe and that the OPFS worker protocol behaves.
 * ==========================================================================*/

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const HKStream = require(path.join(repo, 'hk-stream.js'));

const QUICK = process.argv.includes('--quick');
const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hktest-'));

let failures = 0;
let checks = 0;

function ok(cond, label, extra) {
  checks++;
  if (cond) {
    console.log('  \u2713 ' + label);
  } else {
    failures++;
    console.log('  \u2717 ' + label + (extra ? '  -> ' + extra : ''));
  }
}

function setGlobal(name, value) {
  try {
    globalThis[name] = value;
  } catch {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
}

function section(name) {
  console.log('\n== ' + name + ' ==');
}

/* ------------------------------------------------------------------ *
 * Fake OPFS (backed by a real temp directory)
 * ------------------------------------------------------------------ */

function makeSyncHandle(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  return {
    write(u8, opts) {
      const at = (opts && opts.at) || 0;
      return fs.writeSync(fd, u8, 0, u8.byteLength, at);
    },
    read(u8, opts) {
      const at = (opts && opts.at) || 0;
      return fs.readSync(fd, u8, 0, u8.byteLength, at);
    },
    flush() {
      fs.fsyncSync(fd);
    },
    getSize() {
      return fs.fstatSync(fd).size;
    },
    truncate(size) {
      fs.ftruncateSync(fd, size);
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

async function statSize(filePath) {
  try {
    return (await fsp.stat(filePath)).size;
  } catch {
    return -1;
  }
}

function makeOpfs(root) {
  const dirHandle = (dirPath) => ({
    kind: 'directory',
    async getDirectoryHandle(name, opts = {}) {
      const p = path.join(dirPath, name);
      if (opts.create) await fsp.mkdir(p, { recursive: true });
      else await fsp.access(p);
      return dirHandle(p);
    },
    async getFileHandle(name, opts = {}) {
      const p = path.join(dirPath, name);
      const size = await statSize(p);
      if (size < 0) {
        if (!opts.create) throw new Error('NotFoundError');
        await fsp.writeFile(p, Buffer.alloc(0));
      }
      return fileHandle(p);
    },
    async removeEntry(name, opts = {}) {
      await fsp.rm(path.join(dirPath, name), { recursive: !!(opts && opts.recursive), force: true });
    },
    async *entries() {
      for (const entry of await fsp.readdir(dirPath, { withFileTypes: true })) {
        yield [
          entry.name,
          entry.isDirectory() ? dirHandle(path.join(dirPath, entry.name)) : fileHandle(path.join(dirPath, entry.name)),
        ];
      }
    },
    async *keys() {
      for (const name of await fsp.readdir(dirPath)) yield name;
    },
  });

  const fileHandle = (filePath) => ({
    kind: 'file',
    async createSyncAccessHandle() {
      return makeSyncHandle(filePath);
    },
    async createWritable() {
      const fd = fs.openSync(filePath, 'r+');
      fs.ftruncateSync(fd, 0);
      let pos = 0;
      return {
        async write(data) {
          const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
          fs.writeSync(fd, u8, 0, u8.byteLength, pos);
          pos += u8.byteLength;
        },
        async close() {
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        },
        async abort() {
          fs.closeSync(fd);
        },
      };
    },
    async getFile() {
      const stat = await fsp.stat(filePath);
      if (fs.openAsBlob) {
        const blob = await fs.openAsBlob(filePath);
        return new File([blob], path.basename(filePath));
      }
      return new File([await fsp.readFile(filePath)], path.basename(filePath));
    },
  });

  return {
    root: dirHandle(root),
    navigatorStorage: {
      async getDirectory() {
        return dirHandle(root);
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Fake HTTP server for Build/*.partN
 * ------------------------------------------------------------------ */

function makeFetch(opts = {}) {
  const failures = opts.failures || {}; // { partNumber: timesToFail }
  const calls = {};
  return async function fetchImpl(url, init) {
    const name = String(url).replace(/^part:\/\//, '');
    const file = path.join(repo, 'Build', name);
    const num = Number((name.match(/part(\d+)$/) || [])[1] || 0);
    let size;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      return { ok: false, status: 404, headers: new Headers(), body: null };
    }
    calls[num] = (calls[num] || 0) + 1;
    if (failures[num] && calls[num] <= failures[num]) {
      throw new Error('simulated network error for ' + name);
    }

    const highWaterMark = 1 << 20;
    const nodeStream = fs.createReadStream(file, { highWaterMark });
    const body = Readable.toWeb(nodeStream);
    const originalReader = body.getReader();
    const reader = {
      async read() {
        return originalReader.read();
      },
      async cancel(reason) {
        return originalReader.cancel(reason);
      },
    };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(size) }),
      body: { getReader: () => reader },
    };
  };
}

function partList(prefix, count, sizes) {
  return sizes.map((bytes, i) => ({ url: 'part://' + prefix + '.part' + (i + 1), bytes }));
}

async function sha256File(p) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(p, { highWaterMark: 1 << 22 })
      .on('data', (d) => hash.update(d))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

async function sha256Parts(dir, names) {
  const hash = crypto.createHash('sha256');
  for (const n of names) {
    await new Promise((resolve, reject) => {
      fs.createReadStream(path.join(dir, n), { highWaterMark: 1 << 22 })
        .on('data', (d) => hash.update(d))
        .on('end', resolve)
        .on('error', reject);
    });
  }
  return hash.digest('hex');
}

/* ------------------------------------------------------------------ *
 * Real chunk sizes, read from disk
 * ------------------------------------------------------------------ */

async function readPartSizes(prefix, count) {
  const sizes = [];
  for (let i = 1; i <= count; i++) {
    sizes.push((await fsp.stat(path.join(repo, 'Build', `${prefix}.part${i}`))).size);
  }
  return sizes;
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

console.log('hk-stream version ' + HKStream.VERSION);
console.log('temp dir: ' + tmpRoot);

const wasmSizes = await readPartSizes('hktruffled.wasm', 2);
const dataSizes = QUICK ? null : await readPartSizes('hktruffled.data', 45);
const dataTotal = dataSizes ? dataSizes.reduce((a, b) => a + b, 0) : 0;

section('wasm chunks (2 parts) — OPFS path, byte exactness');
{
  const opfs = makeOpfs(path.join(tmpRoot, 'opfs-wasm'));
  setGlobal('navigator', { storage: opfs.navigatorStorage });
  setGlobal('Worker', class {
    constructor() {
      throw new Error('worker path disabled in this test (using injected writer)');
    }
  });

  // Inject a sink that mimics the worker positional-write contract on top of fs.
  const writerFactory = async ({ dirName, name }) => {
    const dir = path.join(tmpRoot, 'opfs-wasm', dirName);
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
    if ((await statSize(target)) < 0) await fsp.writeFile(target, Buffer.alloc(0));
    const handle = makeSyncHandle(target);
    const markerDir = dir;
    return {
      sequentialOnly: false,
      async open(resume) {
        const size = handle.getSize();
        const start = resume && size < wasmTotal ? size : 0;
        if (!start) handle.truncate(0);
        return { size: start, canResume: start > 0 };
      },
      async write(u8, at) {
        handle.write(u8, { at });
      },
      async finish() {
        handle.flush();
        const size = handle.getSize();
        handle.close();
        return { size };
      },
      async abort() {},
      async stat(n) {
        return statSize(path.join(markerDir, n));
      },
      async putText(n, text) {
        await fsp.writeFile(path.join(markerDir, n), text);
      },
      async getText(n) {
        try {
          return await fsp.readFile(path.join(markerDir, n), 'utf8');
        } catch {
          return null;
        }
      },
      async remove(n) {
        await fsp.rm(path.join(markerDir, n), { force: true });
      },
      destroy() {},
    };
  };

  setGlobal('URL', Object.assign(URL, {
    createObjectURL: (blob) => 'blob:test-' + (blob.size || 0),
    revokeObjectURL: () => {},
  }));

  const wasmTotal = wasmSizes.reduce((a, b) => a + b, 0);
  const progress = [];
  const ds = await HKStream.ensureDataset({
    parts: partList('hktruffled.wasm', 2, wasmSizes),
    expectedSize: wasmTotal,
    cacheKey: 'hktruffled.wasm',
    buildId: 'test-build-1',
    mime: 'application/wasm',
    dirName: 'hk-webgl-cache',
    caps: { opfs: true, workers: false },
    writerFactory,
    fetchImpl: makeFetch(),
    onProgress: (p) => progress.push(p.loaded),
  });

  ok(ds.kind === 'opfs', 'first run wrote to disk (kind=' + ds.kind + ')');
  ok(ds.size === wasmTotal, 'assembled size ' + ds.size + ' == ' + wasmTotal);
  const assembled = path.join(tmpRoot, 'opfs-wasm', 'hk-webgl-cache', 'hktruffled.wasm');
  const h1 = await sha256File(assembled);
  const h2 = await sha256Parts(path.join(repo, 'Build'), wasmSizes.map((_, i) => 'hktruffled.wasm.part' + (i + 1)));
  ok(h1 === h2, 'sha256 matches the plain concatenation of the parts');
  ok(progress.length > 0 && progress[progress.length - 1] === wasmTotal, 'progress ended at 100%');
  const head = (await fsp.readFile(assembled)).subarray(0, 4);
  ok(head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d, 'starts with the wasm magic number');

  section('cache reuse');
  let fetched = 0;
  const fetch2 = async (u, o) => {
    fetched++;
    return makeFetch()(u, o);
  };
  const ds2 = await HKStream.ensureDataset({
    parts: partList('hktruffled.wasm', 2, wasmSizes),
    expectedSize: wasmTotal,
    cacheKey: 'hktruffled.wasm',
    buildId: 'test-build-1',
    mime: 'application/wasm',
    dirName: 'hk-webgl-cache',
    caps: { opfs: true, workers: false },
    writerFactory,
    fetchImpl: fetch2,
  });
  ok(ds2.kind === 'opfs-cached', 'second run came from cache (kind=' + ds2.kind + ')');
  ok(fetched === 0, 'no network requests on the cached run (' + fetched + ' requests)');

  section('resume after an interrupted download');
  {
    let aborted = false;
    const controller = new AbortController();
    const dsPartial = await HKStream.ensureDataset({
      parts: partList('hktruffled.wasm', 2, wasmSizes),
      expectedSize: wasmTotal,
      cacheKey: 'hktruffled.wasm',
      buildId: 'test-build-2',
      dirName: 'hk-webgl-cache',
      caps: { opfs: true, workers: false },
      writerFactory,
      fetchImpl: makeFetch(),
      signal: controller.signal,
      onProgress: (p) => {
        if (!aborted && p.loaded > wasmSizes[0] / 2) {
          aborted = true;
          controller.abort();
        }
      },
    }).then(
      () => null,
      (e) => e
    );
    ok(dsPartial && dsPartial.name === 'AbortError', 'interrupted run aborted as expected');
    const partialSize = await statSize(assembled);
    ok(partialSize > 0 && partialSize < wasmTotal, 'partial file left on disk (' + partialSize + ' bytes)');

    const seen = [];
    const dsResumed = await HKStream.ensureDataset({
      parts: partList('hktruffled.wasm', 2, wasmSizes),
      expectedSize: wasmTotal,
      cacheKey: 'hktruffled.wasm',
      buildId: 'test-build-2',
      dirName: 'hk-webgl-cache',
      caps: { opfs: true, workers: false },
      writerFactory,
      fetchImpl: makeFetch(),
      onProgress: (p) => seen.push(p.loaded),
    });
    ok(seen[0] === partialSize, 'resumed from ' + seen[0] + ' bytes (' + partialSize + ' on disk)');
    ok(dsResumed.size === wasmTotal, 'resumed run produced the full size');
    ok((await sha256File(assembled)) === h2, 'resumed file is byte-identical');
  }

  section('retry after a broken part');
  {
    await HKStream.ensureDataset({
      parts: partList('hktruffled.wasm', 2, wasmSizes),
      expectedSize: wasmTotal,
      cacheKey: 'hktruffled.wasm',
      buildId: 'test-build-3',
      dirName: 'hk-webgl-cache',
      caps: { opfs: true, workers: false },
      writerFactory,
      fetchImpl: makeFetch({ failures: { 1: 2 } }),
      onLog: (m) => process.stdout.write('      · ' + m + '\n'),
    });
    ok((await sha256File(assembled)) === h2, 'file is byte-identical after part retries');
  }

  section('memory fallback');
  {
    const dsMem = await HKStream.ensureDataset({
      parts: partList('hktruffled.wasm', 2, wasmSizes),
      expectedSize: wasmTotal,
      cacheKey: 'hktruffled.wasm',
      buildId: 'test-build-4',
      mime: 'application/wasm',
      caps: { opfs: false, workers: false },
      fetchImpl: makeFetch(),
    });
    ok(dsMem.kind === 'memory', 'fell back to RAM when OPFS is unavailable');
    ok(dsMem.url.startsWith('blob:'), 'produced an object URL');
  }
}

section('hk-writer.js worker protocol');
{
  const workerRoot = path.join(tmpRoot, 'opfs-worker');
  await fsp.mkdir(workerRoot, { recursive: true });
  const src = await fsp.readFile(path.join(repo, 'hk-writer.js'), 'utf8');
  const sent = [];
  const shim = { postMessage: (m) => sent.push(m) };
  const opfs = makeOpfs(workerRoot);
  const factory = new Function('self', 'navigator', 'TextEncoder', src);
  factory(shim, { storage: opfs.navigatorStorage }, TextEncoder);

  let seq = 0;
  const waiters = new Map();
  const originalPost = shim.postMessage;
  shim.postMessage = (m) => {
    const w = waiters.get(m.id);
    if (w) {
      waiters.delete(m.id);
      w(m);
      return;
    }
    originalPost(m);
  };

  function call(msg) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiters.set(id, (reply) => (reply.error ? reject(new Error(reply.error.message)) : resolve(reply)));
      shim.onmessage({ data: Object.assign({}, msg, { id }) });
      setTimeout(() => {
        if (waiters.has(id)) {
          waiters.delete(id);
          reject(new Error('worker timed out: ' + msg.type));
        }
      }, 10000);
    });
  }

  const payloadA = Buffer.from('hello hollow knight ');
  const payloadB = Buffer.from('second chunk');
  await call({ type: 'open', dir: 'd', name: 'f.bin', expected: payloadA.length + payloadB.length, resume: false });
  await call({ type: 'write', data: new Uint8Array(payloadA), at: 0 });
  await call({ type: 'write', data: new Uint8Array(payloadB), at: payloadA.length, flush: true });
  const fin = await call({ type: 'finish' });
  ok(fin.size === payloadA.length + payloadB.length, 'worker wrote ' + fin.size + ' bytes');
  const writtenFile = await fsp.readFile(path.join(workerRoot, 'd', 'f.bin'));
  ok(writtenFile.toString() === payloadA.toString() + payloadB.toString(), 'worker file content is correct');

  await call({ type: 'putText', dir: 'd', name: 'marker', text: 'v1' });
  const got = await call({ type: 'getText', dir: 'd', name: 'marker' });
  ok(got.text === 'v1', 'worker round-trips small text files');
  const st = await call({ type: 'stat', dir: 'd', name: 'f.bin' });
  ok(st.size === payloadA.length + payloadB.length, 'worker stat reports the size');
  const missing = await call({ type: 'stat', dir: 'd', name: 'nope.bin' });
  ok(missing.size === -1, 'worker reports -1 for a missing file');

  // resume: open with resume=true keeps the bytes, resume=false truncates
  const r1 = await call({ type: 'open', dir: 'd', name: 'f.bin', expected: payloadA.length + payloadB.length, resume: true });
  ok(r1.size === payloadA.length + payloadB.length && r1.canResume === true, 'worker can resume an existing file');
  await call({ type: 'finish' });
  const r2 = await call({ type: 'open', dir: 'd', name: 'f.bin', expected: payloadA.length + payloadB.length, resume: false });
  ok(r2.size === 0, 'worker truncates when asked to start over');
  await call({ type: 'finish' });
  await call({ type: 'remove', dir: 'd', name: 'f.bin' });
  ok((await statSize(path.join(workerRoot, 'd', 'f.bin'))) < 0, 'worker removes files');
}

section('ipad.html manifest matches the Build/ folder');
{
  const html = await fsp.readFile(path.join(repo, 'ipad.html'), 'utf8');
  const partConst = Number((html.match(/var PART\s*=\s*(\d+)/) || [])[1]) || 0;
  function grab(name) {
    const at = html.search(new RegExp(name + ':[\\s\\S]*?partBytes:'));
    if (at < 0) throw new Error('could not find ' + name + '.partBytes in ipad.html');
    const lineStart = html.indexOf('partBytes:', at) + 'partBytes:'.length;
    let line = html.slice(lineStart, html.indexOf('\n', lineStart)).trim();
    line = line.replace(/,$/, '').trim();
    const value = new Function('PART', 'return ' + line + ';')(partConst);
    if (!Array.isArray(value) || !value.length) throw new Error('bad partBytes for ' + name + ': ' + line);
    return value;
  }
  function grabTotal(name) {
    const re = new RegExp(name + ':[\\s\\S]*?total:\\s*(\\d+)', 'm');
    const m = html.match(re);
    if (!m) throw new Error('could not find ' + name + '.total in ipad.html');
    return Number(m[1]);
  }

  const pageData = grab('data');
  const pageWasm = grab('wasm');
  const realData = await readPartSizes('hktruffled.data', pageData.length);
  const realWasm = await readPartSizes('hktruffled.wasm', pageWasm.length);
  ok(JSON.stringify(pageData) === JSON.stringify(realData), 'data part sizes in the page match the files on disk');
  ok(JSON.stringify(pageWasm) === JSON.stringify(realWasm), 'wasm part sizes in the page match the files on disk');
  ok(
    grabTotal('data') === realData.reduce((a, b) => a + b, 0),
    'data total in the page (' + grabTotal('data') + ') matches the files'
  );
  ok(
    grabTotal('wasm') === realWasm.reduce((a, b) => a + b, 0),
    'wasm total in the page (' + grabTotal('wasm') + ') matches the files'
  );
  ok(/hk-writer\.js/.test(html), 'the page points at the writer worker');
  ok(/hk-stream\.js/.test(html), 'the page loads hk-stream.js');
}

if (!QUICK) {
  section('full data file (45 parts, ' + HKStream.mb(dataTotal) + ') — end to end');
  {
    const opfs = makeOpfs(path.join(tmpRoot, 'opfs-data'));
    setGlobal('navigator', { storage: opfs.navigatorStorage });
    const writerFactory = async ({ dirName, name }) => {
      const dir = path.join(tmpRoot, 'opfs-data', dirName);
      await fsp.mkdir(dir, { recursive: true });
      const target = path.join(dir, name);
      if ((await statSize(target)) < 0) await fsp.writeFile(target, Buffer.alloc(0));
      const handle = makeSyncHandle(target);
      return {
        sequentialOnly: false,
        async open(resume) {
          const size = handle.getSize();
          const start = resume && size < dataTotal ? size : 0;
          if (!start) handle.truncate(0);
          return { size: start, canResume: start > 0 };
        },
        async write(u8, at) {
          handle.write(u8, { at });
        },
        async finish() {
          handle.flush();
          const size = handle.getSize();
          handle.close();
          return { size };
        },
        async abort() {},
        async stat(n) {
          return statSize(path.join(dir, n));
        },
        async putText(n, text) {
          await fsp.writeFile(path.join(dir, n), text);
        },
        async getText(n) {
          try {
            return await fsp.readFile(path.join(dir, n), 'utf8');
          } catch {
            return null;
          }
        },
        async remove(n) {
          await fsp.rm(path.join(dir, n), { force: true });
        },
        destroy() {},
      };
    };

    const t0 = Date.now();
    let lastLog = 0;
    const ds = await HKStream.ensureDataset({
      parts: partList('hktruffled.data', 45, dataSizes),
      expectedSize: dataTotal,
      cacheKey: 'hktruffled.data',
      buildId: 'test-data-1',
      dirName: 'hk-webgl-cache',
      caps: { opfs: true, workers: false },
      writerFactory,
      fetchImpl: makeFetch(),
      onProgress: (p) => {
        if (Date.now() - lastLog > 3000) {
          lastLog = Date.now();
          process.stdout.write('      · ' + HKStream.mb(p.loaded) + ' / ' + HKStream.mb(p.total) + '\n');
        }
      },
    });
    const target = path.join(tmpRoot, 'opfs-data', 'hk-webgl-cache', 'hktruffled.data');
    ok(ds.size === dataTotal, 'assembled size ' + ds.size + ' == ' + dataTotal);
    console.log('    assembled in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

    const ha = await sha256File(target);
    const hb = await sha256Parts(
      path.join(repo, 'Build'),
      dataSizes.map((_, i) => 'hktruffled.data.part' + (i + 1))
    );
    ok(ha === hb, 'sha256 matches the plain concatenation of the 45 parts');

    // Verify the UnityWebData table of contents is intact.
    // Layout: "UnityWebData1.0\0" (16 bytes), uint32 dataStart, then
    // repeated { uint32 offset, uint32 length, uint32 nameLen, name }.
    const fd = fs.openSync(target, 'r');
    const head = Buffer.alloc(20);
    fs.readSync(fd, head, 0, 20, 0);
    ok(head.subarray(0, 16).toString('utf8') === 'UnityWebData1.0\0', 'UnityWebData header intact');
    const dataStart = head.readUInt32LE(16);
    ok(dataStart > 16 && dataStart < 1 << 20, 'file table occupies the first ' + dataStart + ' bytes');

    const table = Buffer.alloc(dataStart - 20);
    fs.readSync(fd, table, 0, table.length, 20);
    let pos = 0;
    let entries = 0;
    let maxEnd = 0;
    let firstName = null;
    let bad = 0;
    while (pos + 12 <= table.length) {
      const off = table.readUInt32LE(pos);
      const len = table.readUInt32LE(pos + 4);
      const nlen = table.readUInt32LE(pos + 8);
      pos += 12;
      if (nlen <= 0 || nlen > 256 || pos + nlen > table.length) break;
      const name = table.subarray(pos, pos + nlen).toString('utf8');
      pos += nlen;
      if (!firstName) firstName = name;
      if (off + len > dataTotal || off < dataStart) bad++;
      if (off + len > maxEnd) maxEnd = off + len;
      entries++;
    }
    ok(entries > 200, 'parsed ' + entries + ' embedded files from the table');
    ok(firstName === 'boot.config', 'first embedded file is "' + firstName + '"');
    ok(bad === 0, 'every embedded file fits inside the assembled data');
    ok(maxEnd === dataTotal, 'the last embedded file ends exactly at the end of the file');
    ok(pos > 0 && pos <= table.length, 'the table is internally consistent (consumed ' + pos + '/' + table.length + ' bytes)');
    fs.closeSync(fd);

    section('cache reuse for the data file');
    let requested = 0;
    const dsCached = await HKStream.ensureDataset({
      parts: partList('hktruffled.data', 45, dataSizes),
      expectedSize: dataTotal,
      cacheKey: 'hktruffled.data',
      buildId: 'test-data-1',
      dirName: 'hk-webgl-cache',
      caps: { opfs: true, workers: false },
      writerFactory,
      fetchImpl: async (u, o) => {
        requested++;
        return makeFetch()(u, o);
      },
    });
    ok(dsCached.kind === 'opfs-cached' && requested === 0, 'second load needed zero network requests');

    section('build id change invalidates the cache');
    const dsNew = await HKStream.ensureDataset({
      parts: partList('hktruffled.data', 45, dataSizes),
      expectedSize: dataTotal,
      cacheKey: 'hktruffled.data',
      buildId: 'test-data-2',
      dirName: 'hk-webgl-cache',
      caps: { opfs: true, workers: false },
      writerFactory,
      fetchImpl: makeFetch(),
    });
    ok(dsNew.kind === 'opfs', 'rebuilt instead of reusing the other build (kind=' + dsNew.kind + ')');
    ok((await sha256File(target)) === hb, 'rebuilt file is still byte-identical');
  }
}

section('summary');
console.log('  ' + (checks - failures) + '/' + checks + ' checks passed');
await fsp.rm(tmpRoot, { recursive: true, force: true });
if (failures) {
  console.log('  FAILED');
  process.exit(1);
}
console.log('  all good');
