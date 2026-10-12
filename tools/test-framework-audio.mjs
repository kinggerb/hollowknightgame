#!/usr/bin/env node
// Behavioural tests for the WebKit <audio> leak fix in Build/hktruffled.framework.js.
//
// The real Unity audio functions are pulled out of the (minified) framework
// file and run inside a vm sandbox against mock Audio / AudioContext objects,
// so these tests exercise the code that actually ships.
//
// Run: node tools/test-framework-audio.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const framework = await readFile(path.join(here, '..', 'Build', 'hktruffled.framework.js'), 'utf8');

// Extract `function name(...){...}` by matching braces, skipping string literals.
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found in framework: ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

const NAMES = [
  'jsAudioMixinSetPitch',
  'jsAudioAddPendingBlockedAudio',
  'jsAudioCreateCompressedSoundClip',
  'jsAudioCreateChannel',
  '_JS_Sound_Stop',
  '_JS_Sound_Play',
];
const code = NAMES.map((n) => extractFunction(framework, n)).join('\n');

function createSandbox({ play } = {}) {
  const elements = [];
  const timers = new Map();
  let timerId = 0;
  class Audio {
    constructor() {
      this._src = '';
      this.paused = true;
      this.loop = false;
      this.playbackRate = 1;
      this.currentTime = 0;
      this.loads = 0;
      this.onended = null;
      elements.push(this);
    }
    get src() { return this._src; }
    set src(v) { this._src = String(v); }
    getAttribute(name) { return name === 'src' ? this._src : null; }
    pause() { this.paused = true; }
    load() { this.loads++; }
    play() {
      this.paused = false;
      return play ? play(this) : Promise.resolve();
    }
  }
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  const audioContext = {
    currentTime: 0,
    destination: {},
    createGain: node,
    createPanner: node,
    createMediaElementSource(el) {
      return { mediaElement: el, connect() {}, disconnect() { this.disconnected = true; } };
    },
  };
  let blobCount = 0;
  const errors = [];
  const sandbox = {
    Audio,
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:clip-' + (++blobCount), revokeObjectURL() {} },
    setTimeout: (fn, ms) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => { timers.delete(id); },
    console: { log() {}, warn() {}, error: (m) => errors.push(String(m)) },
    dynCall() {},
    WEBAudio: {
      audioInstanceIdCounter: 0,
      audioInstances: {},
      audioContext,
      audioWebEnabled: 1,
      audioCache: [],
      pendingAudioSources: {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, elements, timers, errors };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('stopping a media-element source frees its <audio> decoder', async () => {
  const { sandbox, elements } = createSandbox();
  const clip = sandbox.jsAudioCreateCompressedSoundClip(new ArrayBuffer(8));
  const channel = sandbox.jsAudioCreateChannel(0, 0);
  channel.playSoundClip(clip, 0, 0);
  await Promise.resolve();
  const el = channel.source.mediaElement;
  assert.equal(el.src, clip.url, 'the source plays the clip URL');
  channel.stop(0);
  assert.equal(channel.source, undefined, 'the channel drops its source');
  assert.equal(el.paused, true);
  assert.equal(el.src, '', 'src is cleared');
  assert.equal(el.loads, 1, 'load() is called so WebKit releases the decoder');
  assert.equal(clip.mediaElement.src, clip.url, 'the clip itself stays playable');
  assert.ok(elements.length >= 2);
});

test('replaying a channel (as on a room transition) cleans up the previous element', async () => {
  const { sandbox } = createSandbox();
  const roomA = sandbox.jsAudioCreateCompressedSoundClip(new ArrayBuffer(8));
  const roomB = sandbox.jsAudioCreateCompressedSoundClip(new ArrayBuffer(8));
  sandbox.WEBAudio.audioInstances[1] = roomA;
  sandbox.WEBAudio.audioInstances[2] = roomB;
  sandbox.WEBAudio.audioInstances[3] = sandbox.jsAudioCreateChannel(0, 0);
  sandbox._JS_Sound_Play(1, 3, 0, 0);
  const first = sandbox.WEBAudio.audioInstances[3].source.mediaElement;
  sandbox._JS_Sound_Play(2, 3, 0, 0);
  assert.equal(first.src, '', 'room A music element is released');
  assert.equal(sandbox.WEBAudio.audioInstances[3].source.mediaElement.src, roomB.url);
});

test('cleanup only removes the pending (autoplay-blocked) entry owned by this source', async () => {
  const { sandbox } = createSandbox();
  const clip = sandbox.jsAudioCreateCompressedSoundClip(new ArrayBuffer(8));
  const a = sandbox.jsAudioCreateChannel(0, 0);
  const b = sandbox.jsAudioCreateChannel(0, 0);
  a.playSoundClip(clip, 0, 0);
  b.playSoundClip(clip, 0, 0);
  sandbox.WEBAudio.pendingAudioSources[clip.url] = { sourceNode: b.source, offset: 0 };
  a.stop(0);
  assert.ok(sandbox.WEBAudio.pendingAudioSources[clip.url], 'another channel\'s pending entry survives');
  b.stop(0);
  assert.equal(sandbox.WEBAudio.pendingAudioSources[clip.url], undefined, 'own pending entry is removed');
});

test('a delayed start that never fired is cancelled instead of playing an empty element', async () => {
  const { sandbox, timers } = createSandbox();
  const clip = sandbox.jsAudioCreateCompressedSoundClip(new ArrayBuffer(8));
  const channel = sandbox.jsAudioCreateChannel(0, 0);
  channel.playSoundClip(clip, 5, 0); // 5 s in the future -> setTimeout
  assert.equal(timers.size, 1);
  channel.stop(0);
  assert.equal(timers.size, 0, 'the pending start timer is cleared');
});

test('clearing src during an in-flight play() does not raise an unhandled rejection', async () => {
  let reject;
  const { sandbox } = createSandbox({
    play: () => new Promise((_, r) => { reject = r; }),
  });
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const clip = sandbox.jsAudioCreateCompressedSoundClip(new ArrayBuffer(8));
    const channel = sandbox.jsAudioCreateChannel(0, 0);
    channel.playSoundClip(clip, 0, 0);
    channel.stop(0);
    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled.length, 0, 'the expected AbortError is swallowed');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('_JS_Sound_Play logs the caught error instead of throwing ReferenceError', async () => {
  const { sandbox, errors } = createSandbox();
  sandbox.WEBAudio.audioInstances[1] = sandbox.jsAudioCreateCompressedSoundClip(new ArrayBuffer(8));
  sandbox.WEBAudio.audioInstances[2] = {
    stop() {},
    playSoundClip() { throw new Error('boom'); },
  };
  assert.doesNotThrow(() => sandbox._JS_Sound_Play(1, 2, 0, 0));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /playSoundClip error\. Exception: Error: boom/);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name);
    console.log(err && err.stack ? err.stack : err);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} framework audio tests passed`);
if (failed) process.exit(1);
