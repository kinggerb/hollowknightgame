#!/usr/bin/env node
/**
 * Browser-level smoke tests for the input and touch-pad behavior in ipad.html.
 * The Unity loader is intentionally stubbed: these tests exercise the page UI
 * and event routing without downloading or booting the multi-gigabyte game.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = await readFile(path.join(here, '..', 'ipad.html'), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createPage({ touch = true, gamepad = null, storage = null, mediaPlay = null } = {}) {
  const jsdomErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error));
  const dom = new JSDOM(html, {
    url: 'https://hk.test/ipad.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.navigator, 'maxTouchPoints', {
        configurable: true,
        value: touch ? 1 : 0,
      });
      window.fetch = async () => ({ ok: true, status: 200 });
      if (mediaPlay) {
        // Must be in place before the page script runs: init() patches
        // HTMLMediaElement.prototype.play, and the guard has to wrap *this*
        // stand-in so the tests see what a real Safari rejection becomes.
        window.HTMLMediaElement.prototype.play = mediaPlay;
      }
      if (storage) {
        for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
      }
      window.HKStream = {
        VERSION: 'test',
        detect: async () => ({
          opfs: false, quota: 0, usage: 0, available: 0,
          secure: true, workers: false,
        }),
      };
      if (gamepad) {
        Object.defineProperty(window.navigator, 'getGamepads', {
          configurable: true,
          value: () => gamepad,
        });
      }
    },
  });
  // Let the page's initial promise callbacks install the remaining listeners.
  await sleep(0);
  assert.deepEqual(jsdomErrors, [], 'ipad.html should initialize without script errors');
  return { dom, window: dom.window, jsdomErrors };
}

function dispatch(window, target, type, properties = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
  target.dispatchEvent(event);
  return event;
}

function keyEvent(window, target, type, key) {
  const code = key.length === 1
    ? `Key${key.toUpperCase()}`
    : key === ' '
      ? 'Space'
      : key;
  const keyCode = key.length === 1
    ? key.toUpperCase().charCodeAt(0)
    : ({ Escape: 27, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key] || 0);
  const event = new window.KeyboardEvent(type, {
    key,
    code,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function padIsVisible(window) {
  return window.document.getElementById('pad').classList.contains('on');
}

function recordKey(window, canvas, key) {
  const events = [];
  ['keydown', 'keyup'].forEach((type) => {
    canvas.addEventListener(type, (event) => {
      if (event.key.toLowerCase() === key.toLowerCase()) events.push(type);
    });
  });
  return events;
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test('touchscreen taps (including touch-pad buttons) never auto-hide the pad', async () => {
  const { dom, window } = await createPage();
  try {
    const pad = window.document.getElementById('pad');
    const button = pad.querySelector('button[data-key="z"]');
    const canvas = window.document.getElementById('unity-canvas');
    assert.equal(padIsVisible(window), true, 'touch devices start with the pad visible');

    dispatch(window, button, 'touchstart', { touches: [{ clientX: 10, clientY: 10 }] });
    dispatch(window, button, 'touchend', { touches: [], changedTouches: [{ clientX: 10, clientY: 10 }] });
    dispatch(window, canvas, 'touchstart', { touches: [{ clientX: 200, clientY: 200 }] });
    dispatch(window, canvas, 'touchend', { touches: [], changedTouches: [{ clientX: 200, clientY: 200 }] });

    assert.equal(padIsVisible(window), true);
  } finally {
    dom.window.close();
  }
});

test('physical keyboard and mouse input hide the pad; Escape restores it', async () => {
  const { dom, window } = await createPage();
  try {
    const canvas = window.document.getElementById('unity-canvas');
    keyEvent(window, canvas, 'keydown', 'q');
    assert.equal(padIsVisible(window), false, 'a physical keyboard key hides the pad');
    keyEvent(window, canvas, 'keyup', 'q');

    keyEvent(window, canvas, 'keydown', 'Escape');
    assert.equal(padIsVisible(window), true, 'Escape restores an auto-hidden pad');
    keyEvent(window, canvas, 'keyup', 'Escape');

    dispatch(window, canvas, 'pointerdown', { pointerType: 'mouse' });
    assert.equal(padIsVisible(window), false, 'a real mouse pointer hides the pad');
  } finally {
    dom.window.close();
  }
});

test('a long press restores the pad after a short tap leaves it hidden', async () => {
  const { dom, window } = await createPage();
  try {
    const canvas = window.document.getElementById('unity-canvas');
    keyEvent(window, canvas, 'keydown', 'q');
    keyEvent(window, canvas, 'keyup', 'q');
    assert.equal(padIsVisible(window), false);

    dispatch(window, canvas, 'touchstart', {
      touches: [{ clientX: 100, clientY: 100 }],
      changedTouches: [{ clientX: 100, clientY: 100 }],
    });
    await sleep(80);
    dispatch(window, canvas, 'touchend', {
      touches: [],
      changedTouches: [{ clientX: 100, clientY: 100 }],
    });
    assert.equal(padIsVisible(window), false, 'a short tap does not restore the pad');

    dispatch(window, canvas, 'touchstart', {
      touches: [{ clientX: 100, clientY: 100 }],
      changedTouches: [{ clientX: 100, clientY: 100 }],
    });
    await sleep(700);
    assert.equal(padIsVisible(window), true, 'holding a touch restores the pad');
    dispatch(window, canvas, 'touchend', {
      touches: [],
      changedTouches: [{ clientX: 100, clientY: 100 }],
    });

    keyEvent(window, canvas, 'keydown', 'q');
    keyEvent(window, canvas, 'keyup', 'q');
    dispatch(window, canvas, 'pointerdown', { pointerType: 'touch', clientX: 30, clientY: 40 });
    await sleep(700);
    assert.equal(padIsVisible(window), true, 'pointer-only touch input also supports long-press restore');
    dispatch(window, canvas, 'pointerup', { pointerType: 'touch', clientX: 30, clientY: 40 });
  } finally {
    dom.window.close();
  }
});

test('gamepad button/axis activity hides the pad without hiding again for a held input', async () => {
  const gamepad = [{
    index: 0,
    connected: true,
    buttons: [{ pressed: false, value: 0 }],
    axes: [0, 0],
  }];
  const { dom, window } = await createPage({ gamepad });
  try {
    const canvas = window.document.getElementById('unity-canvas');
    await sleep(140);
    assert.equal(padIsVisible(window), true, 'an idle controller does not hide the pad');

    gamepad[0].buttons[0] = { pressed: true, value: 1 };
    await sleep(140);
    assert.equal(padIsVisible(window), false, 'a pressed controller button hides the pad');

    keyEvent(window, canvas, 'keydown', 'Escape');
    keyEvent(window, canvas, 'keyup', 'Escape');
    await sleep(140);
    assert.equal(padIsVisible(window), true, 'an unchanged held button does not immediately hide it again');

    gamepad[0].buttons[0] = { pressed: false, value: 0 };
    await sleep(140);
    gamepad[0].axes[0] = 0.8;
    await sleep(140);
    assert.equal(padIsVisible(window), false, 'new analog-stick activity hides the pad');
  } finally {
    dom.window.close();
  }
});

test('a keyboard keyup cannot release a key still held by the touch pad', async () => {
  const { dom, window } = await createPage();
  try {
    const canvas = window.document.getElementById('unity-canvas');
    const events = recordKey(window, canvas, 'z');
    const button = window.document.querySelector('#pad button[data-key="z"]');

    keyEvent(window, canvas, 'keydown', 'z');
    assert.equal(padIsVisible(window), false);
    keyEvent(window, canvas, 'keydown', 'Escape');
    keyEvent(window, canvas, 'keyup', 'Escape');
    assert.equal(padIsVisible(window), true);

    dispatch(window, button, 'touchstart');
    keyEvent(window, canvas, 'keyup', 'z');
    assert.deepEqual(events, ['keydown'], 'the physical keyup is swallowed while the touch key is held');
    dispatch(window, button, 'touchend');
    assert.deepEqual(events, ['keydown', 'keyup'], 'the final touch release sends exactly one keyup');
  } finally {
    dom.window.close();
  }
});

test('a touch-pad release cannot release a key still held by the physical keyboard', async () => {
  const { dom, window } = await createPage();
  try {
    const canvas = window.document.getElementById('unity-canvas');
    const events = recordKey(window, canvas, 'z');
    const button = window.document.querySelector('#pad button[data-key="z"]');

    dispatch(window, button, 'touchstart');
    assert.deepEqual(events, ['keydown'], 'touch starts the aggregate key once');
    keyEvent(window, canvas, 'keydown', 'z');
    assert.deepEqual(events, ['keydown'], 'the overlapping physical keydown is swallowed');
    assert.equal(padIsVisible(window), false, 'physical keyboard use hides the pad');

    keyEvent(window, canvas, 'keyup', 'z');
    assert.deepEqual(events, ['keydown', 'keyup'], 'the keyboard release is delivered after the pad is released by hiding');
  } finally {
    dom.window.close();
  }
});

function clickButton(window, id) {
  window.document.getElementById(id).dispatchEvent(new window.Event('click', { bubbles: true }));
}

function heartbeat(overrides = {}) {
  const now = Date.now();
  return JSON.stringify(Object.assign({
    at: now - 30000,
    start: now - 15 * 60000,
    preset: 'balanced',
    scale: 0.85,
    fps: 60,
    measured: 58,
    visible: true,
  }, overrides));
}

test('the render scale decides how big the canvas backing store is', async () => {
  const { dom, window } = await createPage({
    storage: { 'hk.perf': JSON.stringify({ preset: 2, scale: 0.7, fps: 45, auto: true }) },
  });
  try {
    const canvas = window.document.getElementById('unity-canvas');
    assert.equal(canvas.width, Math.round(window.innerWidth * 0.7));
    assert.equal(canvas.height, Math.round(window.innerHeight * 0.7));
    assert.equal(canvas.style.transform, 'scale(1.4286)', 'the small canvas is stretched back over the screen');
    assert.equal(window.HKPerf.settings().presetId, 'smooth', 'a saved level is picked up again');
    assert.equal(window.HKPerf.settings().fps, 45);
  } finally {
    dom.window.close();
  }
});

test('the frame cap holds the game loop back; uncapped mode does not', async () => {
  const { dom, window } = await createPage();
  try {
    const sample = async (count) => {
      const stamps = [];
      await new Promise((resolve) => {
        let n = 0;
        const step = (t) => {
          stamps.push(t);
          if (++n < count) window.requestAnimationFrame(step);
          else resolve();
        };
        window.requestAnimationFrame(step);
      });
      return stamps;
    };

    window.HKPerf.setFps(30);           // 30 fps -> about 33 ms between frames
    const capped = await sample(4);
    const cappedGap = capped[3] - capped[2];
    assert.ok(cappedGap >= 28, `a 30 fps cap should space frames ~33 ms apart, got ${cappedGap.toFixed(1)} ms`);

    window.HKPerf.setFps(0);            // uncapped -> straight through
    const free = await sample(4);
    const freeGap = free[3] - free[2];
    assert.ok(freeGap < 28, `uncapped frames should not be delayed, got ${freeGap.toFixed(1)} ms`);
  } finally {
    dom.window.close();
  }
});

test('the graphics button walks the presets and remembers the choice', async () => {
  const { dom, window } = await createPage();
  try {
    const button = window.document.getElementById('perfBtn');
    assert.match(button.textContent, /Graphics: Balanced/, 'touch devices start at Balanced');
    const ids = Array.from(window.HKPerf.presets());

    clickButton(window, 'perfBtn');
    assert.match(button.textContent, /Graphics: Smooth/);
    const saved = JSON.parse(window.localStorage.getItem('hk.perf'));
    assert.equal(ids[saved.preset], 'smooth');
    assert.equal(saved.fps, 45, 'the preset sets the frame cap as well');
    assert.equal(saved.scale, 0.7, 'and the render scale');

    clickButton(window, 'fpsBtn');
    assert.match(window.document.getElementById('fpsBtn').textContent, /Frame cap: 30/);
    assert.equal(window.HKPerf.settings().scale, 0.7, 'the frame cap button only changes the cap');

    clickButton(window, 'queueBtn');
    assert.match(window.document.getElementById('queueBtn').textContent, /Render scale: 55%/);
    assert.equal(window.HKPerf.settings().fps, 30, 'the render scale button only changes the scale');

    clickButton(window, 'autoBtn');
    assert.match(window.document.getElementById('autoBtn').textContent, /Auto-degrade: off/);
    assert.equal(JSON.parse(window.localStorage.getItem('hk.perf')).auto, false);
  } finally {
    dom.window.close();
  }
});

test('auto-degrade steps down when the frame rate stays low, and only then', async () => {
  const { dom, window } = await createPage();
  try {
    assert.equal(window.HKPerf.settings().presetId, 'balanced');
    let degraded = false;
    for (let i = 0; i < 4 && !degraded; i++) degraded = window.HKPerf.autoTick(35, true);
    assert.ok(degraded, 'repeated slow samples lower the graphics level');
    assert.equal(window.HKPerf.settings().presetId, 'smooth');

    const level = window.HKPerf.settings().presetId;
    for (let i = 0; i < 6; i++) window.HKPerf.autoTick(60, true);
    assert.equal(window.HKPerf.settings().presetId, level, 'a healthy frame rate never degrades');

    window.HKPerf.setFps(0);
    let again = false;
    for (let i = 0; i < 4 && !again; i++) again = window.HKPerf.autoTick(30, true);
    assert.ok(again, 'uncapped play is measured against 55 fps, so 30 fps still degrades');
  } finally {
    dom.window.close();
  }
});

test('a session that ended without a clean exit starts one graphics step lower', async () => {
  const { dom, window } = await createPage({ storage: { 'hk.heartbeat': heartbeat() } });
  try {
    const info = window.HKPerf.lastSession();
    assert.ok(info && info.crashed, 'a stale heartbeat means the tab was killed');
    assert.equal(info.streak, 1);
    assert.equal(window.HKPerf.settings().presetId, 'smooth', 'Balanced plus one crash starts at Smooth');
    assert.equal(window.localStorage.getItem('hk.heartbeat'), null, 'the heartbeat is consumed');
    assert.equal(window.localStorage.getItem('hk.crashStreak'), '1');

    clickButton(window, 'perfBtn');
    assert.equal(window.localStorage.getItem('hk.crashStreak'), '0', 'picking a level clears the crash streak');
  } finally {
    dom.window.close();
  }
});

test('a tab killed in the background is not treated as a graphics crash', async () => {
  const { dom, window } = await createPage({
    storage: { 'hk.heartbeat': heartbeat({ visible: false }) },
  });
  try {
    const info = window.HKPerf.lastSession();
    assert.ok(info && !info.crashed, 'iPadOS evicting a background tab is normal');
    assert.equal(info.streak, 0);
    assert.equal(window.HKPerf.settings().presetId, 'balanced', 'the level is left alone');
  } finally {
    dom.window.close();
  }
});

test('leaving the page normally clears the crash heartbeat', async () => {
  const { dom, window } = await createPage({ storage: { 'hk.heartbeat': heartbeat() } });
  try {
    assert.equal(window.HKPerf.lastSession().crashed, true);
    assert.equal(window.localStorage.getItem('hk.crashStreak'), '1');

    // Safari reloads the page by itself after a kill. That fresh page never
    // booted the game, so its pagehide must not be mistaken for a clean exit
    // or the streak is wiped before the ladder has climbed anywhere.
    window.localStorage.setItem('hk.heartbeat', heartbeat());
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(window.localStorage.getItem('hk.heartbeat'), null, 'the heartbeat is always cleared');
    assert.equal(window.localStorage.getItem('hk.crashStreak'), '1', 'a reload that never booted keeps the streak');

    window.HKPerf.autoTick(60, true);        // the game is really running now
    window.localStorage.setItem('hk.heartbeat', heartbeat());
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(window.localStorage.getItem('hk.heartbeat'), null);
    assert.equal(window.localStorage.getItem('hk.crashStreak'), '0', 'a clean exit after boot clears it');
  } finally {
    dom.window.close();
  }
});

test('a game heap that grows towards the iPad limit warns once', async () => {
  const { dom, window } = await createPage();
  try {
    // only the byte length is read, so no real allocation is needed
    window.unityInstance = { Module: { HEAPU8: { length: 1700 * 1048576 } } };
    assert.equal(window.HKPerf.heapMB(), 1700);
    window.HKPerf.autoTick(60, true);        // pretend the game is running

    const toast = window.document.getElementById('toast');
    window.HKPerf.checkMemory();
    assert.match(toast.textContent, /1700 MB/, 'the warning names the heap size');
    assert.ok(toast.classList.contains('show'));

    toast.textContent = '';
    window.HKPerf.checkMemory();
    assert.equal(toast.textContent, '', 'the warning is only shown once');
  } finally {
    dom.window.close();
  }
});

test('a lost WebGL context offers a reload instead of leaving a frozen canvas', async () => {
  const { dom, window } = await createPage();
  try {
    const canvas = window.document.getElementById('unity-canvas');
    const overlay = window.document.getElementById('recover');
    const event = new window.Event('webglcontextlost', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(event);
    assert.equal(overlay.classList.contains('hidden'), false, 'the recovery overlay appears');
    assert.equal(event.defaultPrevented, true, 'preventDefault() keeps the context restorable');
    assert.match(window.document.getElementById('recoverMsg').textContent, /graphics context/);

    clickButton(window, 'recoverWait');
    assert.equal(overlay.classList.contains('hidden'), true, '“keep waiting” dismisses it');
  } finally {
    dom.window.close();
  }
});

test('the audio guard relabels a NotSupportedError rejection as NotAllowedError', async () => {
  const { dom, window } = await createPage({
    mediaPlay: () => Promise.reject(Object.assign(new Error('nope'), { name: 'NotSupportedError' })),
  });
  try {
    assert.equal(window.__hkPlayPatched, true, 'the guard is installed at init, before Unity loads');
    const element = window.document.createElement('audio');
    const rejection = await element.play().then(() => null, (error) => error);

    assert.ok(rejection, 'play() still rejects — Unity has to know the element did not start');
    assert.equal(rejection.name, 'NotAllowedError',
      'NotSupportedError is the one Unity rethrows; NotAllowedError is the one it retries');
    assert.equal(window.__hkAudioFails, 1, 'the failure is counted');
  } finally {
    dom.window.close();
  }
});

test('the audio guard catches a play() that throws outright', async () => {
  const { dom, window } = await createPage({
    mediaPlay: () => { throw Object.assign(new Error('boom'), { name: 'NotSupportedError' }); },
  });
  try {
    const element = window.document.createElement('audio');
    const rejection = await element.play().then(() => null, (error) => error);

    assert.ok(rejection, 'a synchronous throw is turned into a rejection instead of escaping into Unity');
    assert.equal(rejection.name, 'NotAllowedError');
  } finally {
    dom.window.close();
  }
});

test('the crash ladder reaches the lowest level, and remembers the heap it died at', async () => {
  const { dom, window } = await createPage();
  try {
    assert.deepEqual(Array.from(window.HKPerf.presets()),
      ['high', 'balanced', 'smooth', 'low', 'potato', 'minimum', 'rock_bottom']);

    // Walk the whole ladder. Each step needs three slow samples, and the
    // cooldowns are cleared by force mode, so a fixed number of ticks is
    // enough; once the bottom is reached further ticks change nothing.
    const walked = [];
    for (let i = 0; i < 60; i++) {
      window.HKPerf.autoTick(1, true);
      const id = window.HKPerf.settings().presetId;
      if (walked[walked.length - 1] !== id) walked.push(id);
    }
    assert.deepEqual(walked,
      ['balanced', 'smooth', 'low', 'potato', 'minimum', 'rock_bottom'],
      'auto-degrade passes through every level on the way down');
    assert.equal(window.HKPerf.settings().scale, 0.25, 'and stops at the floor');
    assert.equal(window.HKPerf.settings().fps, 20, 'past the last preset the frame cap keeps stepping down');
  } finally {
    dom.window.close();
  }

  // The heap a killed session died at is what the next one warns against.
  const second = await createPage({ storage: { 'hk.heartbeat': heartbeat({ heap: 1700 }) } });
  try {
    const w = second.window;
    assert.equal(w.HKPerf.lastSession().crashed, true);
    assert.equal(w.localStorage.getItem('hk.crashHeap'), '1700', 'the heap it died at is remembered');

    const limits = w.HKPerf.memoryLimits();
    assert.equal(limits.crashHeap, 1700);
    assert.equal(limits.warn, 1360, '80 % of the heap that killed it');
    assert.equal(limits.alarm, 1615, '95 % of it');

    w.unityInstance = { Module: { HEAPU8: { length: 1500 * 1048576 } } };
    w.HKPerf.refreshPerfRows();
    const rows = w.document.getElementById('perfRows').textContent;
    assert.match(rows, /tab total \(heap \+ game data\)/);
    assert.match(rows, /2384 MB/, 'heap plus the 884 MB of game data');
    assert.match(rows, /last crash at/);
    assert.match(rows, /1700 MB heap/, 'the panel says what the limits were learned from');
  } finally {
    second.dom.window.close();
  }
});

test('the lowest levels really do shrink the canvas', async () => {
  const { dom, window } = await createPage({
    storage: { 'hk.perf': JSON.stringify({ preset: 4, scale: 0.4, fps: 30, auto: false }) },
  });
  try {
    const canvas = window.document.getElementById('unity-canvas');
    assert.equal(window.HKPerf.settings().presetId, 'potato');
    const potato = { w: canvas.width, h: canvas.height };
    assert.equal(potato.w, Math.round(window.innerWidth * 0.4));

    window.HKPerf.setScale(0.3);
    const minimum = { w: canvas.width, h: canvas.height };
    assert.ok(minimum.w < potato.w, `Minimum should draw fewer pixels than Potato (${minimum.w} < ${potato.w})`);
    assert.ok(minimum.h < potato.h, `and fewer rows (${minimum.h} < ${potato.h})`);

    window.HKPerf.setScale(0.25);
    const rock = { w: canvas.width, h: canvas.height };
    assert.ok(rock.w < minimum.w, `Rock bottom should draw fewer pixels than Minimum (${rock.w} < ${minimum.w})`);
    assert.ok(rock.h < minimum.h, `and fewer rows (${rock.h} < ${minimum.h})`);
    assert.equal(rock.w, Math.round(window.innerWidth * 0.25),
      'the resolution floor is low enough not to clamp the bottom levels back up');
    assert.equal(rock.h, Math.round(window.innerHeight * 0.25));
    assert.equal(canvas.style.transform, 'scale(4.0000)', 'the small canvas is still stretched over the screen');
  } finally {
    dom.window.close();
  }
});

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
  console.error(`\n${failures} of ${tests.length} iPad page tests failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} iPad page tests passed`);
}
