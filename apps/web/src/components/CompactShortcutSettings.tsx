import { useEffect, useState } from "react";

type Status = { enabled: boolean; accelerator: string; registered: boolean; error: string };
export function shortcutLabel(accelerator: string) {
  const mac = /Mac/.test(navigator.platform);
  return accelerator.split("+").map((part) => ({ CommandOrControl: mac ? "⌘" : "Ctrl", Command: "⌘", Control: "Ctrl", Alt: mac ? "⌥" : "Alt", Shift: "⇧" }[part] || part)).join(" + ");
}
export function CompactShortcutSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [accelerator, setAccelerator] = useState("CommandOrControl+Shift+H");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.duobookDesktop?.getCompactShortcut().then((value) => {
      if (!cancelled) { setStatus(value); setEnabled(value.enabled); setAccelerator(value.accelerator); }
    }).catch(() => { if (!cancelled) setError("无法读取全局快捷键设置，请重新打开设置重试。"); });
    return () => { cancelled = true; void window.duobookDesktop?.setCompactShortcutRecording(false).catch(() => {}); };
  }, []);
  if (!window.duobookDesktop) return <p>全局隐藏 / 显示仅桌面版支持；网页快捷键需当前页面获得焦点。</p>;
  const save = async () => {
    setBusy(true); setError("");
    try {
      const next = await window.duobookDesktop!.saveCompactShortcut({ enabled, accelerator });
      setStatus(next);
    } catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "快捷键保存失败，请重试。"); }
    finally { setBusy(false); }
  };
  return <section className="compact-reader__shortcut" aria-label="全局快捷键设置">
    <label className="compact-reader__check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用全局隐藏 / 显示快捷键</label>
    <label>全局快捷键<input type="text" aria-label="全局隐藏显示快捷键" readOnly value={shortcutLabel(accelerator)} placeholder="按下新组合键" onFocus={() => { void window.duobookDesktop?.setCompactShortcutRecording(true); }} onBlur={() => { void window.duobookDesktop?.setCompactShortcutRecording(false); }} onKeyDown={(event) => {
      if (event.key === "Tab") return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") { if (status) setAccelerator(status.accelerator); event.currentTarget.blur(); return; }
      if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
      const modifiers = [...(event.metaKey ? ["CommandOrControl"] : []), ...(event.ctrlKey ? ["Control"] : []), ...(event.altKey ? ["Alt"] : []), ...(event.shiftKey ? ["Shift"] : [])];
      const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5) : event.key.toUpperCase();
      if (modifiers.length < 2 || !/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/.test(key)) { setError("请按至少两个修饰键，再加一个字母、数字或功能键。"); return; }
      setError(""); setAccelerator([...modifiers, key].join("+"));
    }} /></label>
    <p>点击输入框后按新组合键，再保存。小窗失去焦点也能切换；显示后保持静音。</p>
    <button className="button button--secondary button--small" disabled={busy || !status} onClick={save}>{busy ? "正在保存…" : "保存全局快捷键"}</button>
    {status ? <p role="status" aria-label="全局快捷键状态">{status.error || (status.registered ? `已生效：${shortcutLabel(status.accelerator)}` : status.enabled ? "快捷键尚未注册，请重新保存或更换组合键。" : "全局快捷键已关闭")}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
