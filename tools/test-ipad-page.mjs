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

async function createPage({ touch = true, gamepad = null } = {}) {
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
