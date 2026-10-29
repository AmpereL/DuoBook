const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SHORTCUT = { enabled: true, accelerator: 'CommandOrControl+Shift+H' };
function createCompactShortcut({ data, onToggle, registry = require('electron').globalShortcut }) {
  const file = path.join(data, 'compact-shortcut.json');
  const valid = (value) => value && typeof value.enabled === 'boolean' && typeof value.accelerator === 'string'
    && value.accelerator.length <= 90 && /^(?:(?:CommandOrControl|Command|Control|Alt|Shift)\+){2,4}(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/.test(value.accelerator)
    && new Set(value.accelerator.split('+').slice(0, -1)).size === value.accelerator.split('+').length - 1;
  let configuration = { ...DEFAULT_SHORTCUT };
  try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (valid(saved)) configuration = { enabled: saved.enabled, accelerator: saved.accelerator }; } catch { /* Use the default for missing or invalid preferences. */ }
  let active = false, registered = false, error = '';
  const status = () => ({ ...configuration, registered, error });
  const conflict = '全局快捷键已被系统或其他应用占用，请换一组组合键后保存。';
  const release = () => { if (registered) registry.unregister(configuration.accelerator); registered = false; };
  const activate = () => {
    if (active && registered) return status();
    active = true; error = '';
    if (configuration.enabled) {
      try { registered = registry.register(configuration.accelerator, onToggle); }
      catch { registered = false; }
      if (!registered) error = conflict;
    }
    return status();
  };
  const save = (value) => {
    if (!valid(value)) throw new Error('快捷键需包含至少两个修饰键和一个字母、数字或 F1–F24。');
    const next = { enabled: value.enabled, accelerator: value.accelerator };
    let nextRegistered = false;
    const reuse = registered && next.enabled && next.accelerator === configuration.accelerator;
    if (active && next.enabled) {
      try { nextRegistered = reuse || registry.register(next.accelerator, onToggle); }
      catch { nextRegistered = false; }
      if (!nextRegistered) throw new Error(conflict);
    }
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (failure) {
      if (nextRegistered && !reuse) registry.unregister(next.accelerator);
      throw failure;
    }
    if (registered && !reuse) release();
    configuration = next; registered = nextRegistered; error = '';
    return status();
  };
  return { status, activate, save, deactivate: () => { release(); active = false; error = ''; } };
}
module.exports = { createCompactShortcut, DEFAULT_SHORTCUT };
