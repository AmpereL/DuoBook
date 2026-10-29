const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCompactShortcut, DEFAULT_SHORTCUT } = require('./compact-shortcut.cjs');

function setup() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-shortcut-test-'));
  const callbacks = new Map(), occupied = new Set();
  const registry = { register: (key, callback) => { if (callbacks.has(key) || occupied.has(key)) return false; callbacks.set(key, callback); return true; }, unregister: key => callbacks.delete(key) };
  let toggles = 0;
  const manager = createCompactShortcut({ data, registry, onToggle: () => toggles++ });
  return { data, callbacks, occupied, registry, manager, toggles: () => toggles };
}
test('default shortcut registers only while the reader is active and releases on close', () => {
  const fixture = setup();
  assert.equal(fixture.manager.status().registered, false);
  fixture.manager.activate();
  fixture.callbacks.get(DEFAULT_SHORTCUT.accelerator)();
  assert.equal(fixture.toggles(), 1);
  fixture.manager.deactivate();
  assert.equal(fixture.callbacks.size, 0);
});
test('changing the shortcut persists; disabling and reenabling work', () => {
  const fixture = setup(); fixture.manager.activate();
  fixture.manager.save({ enabled: true, accelerator: 'Control+Alt+J' });
  assert.equal(fixture.callbacks.has(DEFAULT_SHORTCUT.accelerator), false);
  assert.equal(fixture.callbacks.has('Control+Alt+J'), true);
  fixture.manager.save({ enabled: false, accelerator: 'Control+Alt+J' });
  assert.equal(fixture.callbacks.size, 0);
  const restored = createCompactShortcut({ data: fixture.data, registry: fixture.registry, onToggle: () => {} });
  assert.equal(restored.activate().registered, false);
  assert.equal(restored.save({ enabled: true, accelerator: 'Control+Alt+J' }).registered, true);
  restored.deactivate();
});
test('conflict or invalid input preserves the working shortcut and saved configuration', () => {
  const fixture = setup(); fixture.manager.activate();
  fixture.manager.save(DEFAULT_SHORTCUT);
  fixture.occupied.add('Control+Alt+J');
  assert.throws(() => fixture.manager.save({ enabled: true, accelerator: 'Control+Alt+J' }), /占用/);
  assert.equal(fixture.manager.status().accelerator, DEFAULT_SHORTCUT.accelerator);
  assert.equal(fixture.callbacks.has(DEFAULT_SHORTCUT.accelerator), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.data, 'compact-shortcut.json'), 'utf8')), DEFAULT_SHORTCUT);
  assert.throws(() => fixture.manager.save({ enabled: true, accelerator: 'H' }), /至少两个/);
  assert.throws(() => fixture.manager.save({ enabled: true, accelerator: 'Shift+Shift+H' }), /至少两个/);
});
test('registration failure reports a conflict; it can be retried without restarting', () => {
  const fixture = setup(); fixture.occupied.add(DEFAULT_SHORTCUT.accelerator);
  assert.match(fixture.manager.activate().error, /占用/);
  fixture.occupied.clear();
  assert.equal(fixture.manager.save(DEFAULT_SHORTCUT).registered, true);
});
