import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowUpRight, ChevronLeft, ChevronRight, GripVertical, LoaderCircle, MoreHorizontal, Pause, Pin, Play, Volume2, X } from "lucide-react";
import { api } from "../api";
import { anchorIndex, compactKey, lineChunks, loadCompact, normalizeCompact, type CompactPreferences, type ReadingAnchor } from "../compactReading";
import { idleSpeech, loadSpeechSettings, MIMO_VOICES, ReaderSpeechPlayer, type SpeechSettings, type SpeechSnapshot } from "../speech";
import type { Paragraph } from "../types";
import { flushReadingPositions, rememberReadingPosition } from "../readingPosition";
import { CompactShortcutSettings } from "../components/CompactShortcutSettings";
import { highlightedText } from "../components/OriginalTextHighlight";
import { useCompactAnnotation } from "../components/useCompactAnnotation";

const native = () => Boolean(window.duobookDesktop);
export function CompactReaderPage() {
  const params = useParams();
  const [ready, setReady] = useState(!native());
  const [preferenceError, setPreferenceError] = useState("");
  useEffect(() => {
    let cancelled = false;
    document.documentElement.classList.add("compact-document");
    document.title = "资料";
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const oldIcon = icon?.getAttribute("href");
    if (icon) icon.href = "/document-icon.svg";
    if (window.duobookDesktop) window.duobookDesktop.getCompactPreferences().then((saved) => {
      if (!cancelled && saved) localStorage.setItem(compactKey, JSON.stringify(normalizeCompact(saved)));
    }).catch(() => { if (!cancelled) setPreferenceError("阅读偏好未能读取，本次设置仍可使用。"); })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; document.documentElement.classList.remove("compact-document"); document.title = "逻辑阅读"; if (icon && oldIcon) icon.href = oldIcon; };
  }, []);
  return ready ? <CompactReader key={`${params.bookId}:${params.chapterId || params.unitId}`} initialError={preferenceError} /> : <div className="compact-boot" role="status">资料加载中…</div>;
}

function CompactReader({ initialError }: { initialError: string }) {
  const { bookId, chapterId, unitId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [search] = useSearchParams();
  const scope = `${bookId}:${chapterId || unitId}`;
  const [prefs, setPrefs] = useState(loadCompact);
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const [settings, setSettings] = useState(loadSpeechSettings);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const changedSettings = useRef(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [chunks, setChunks] = useState<ReturnType<typeof lineChunks>>([]);
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0); indexRef.current = index;
  const [snapshot, setSnapshot] = useState<SpeechSnapshot>(idleSpeech);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState(initialError);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [position, setPosition] = useState({ x: prefs.x, y: prefs.y });
  const anchor = useRef<ReadingAnchor | undefined>(search.get("paragraph") ? { paragraphId: search.get("paragraph")!, offset: Number(search.get("offset")) || 0 } : location.state?.resetPosition ? undefined : prefs.positions[scope]);
  const explicitEntry = useRef(search.has("paragraph") || location.state?.resetPosition === true);
  const bookmarkApplied = useRef(false);
  const player = useRef<ReaderSpeechPlayer | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const autoStart = useRef(location.state?.autoPlay === true);
  const pausedForSelection = useRef(false);
  const startAtEnd = useRef(location.state?.startAtEnd === true);
  const autoAdvance = useRef<() => void>(() => {});
  const wheel = useRef({ accumulated: 0, last: 0, changed: 0 });
  const drag = useRef<{ pointer: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const source = useQuery({
    queryKey: ["compact-source", bookId, chapterId, unitId],
    queryFn: async () => unitId ? api.getReadingUnit(unitId) : api.getChapter(bookId!, chapterId!),
  });
  const directory = useQuery({ queryKey: ["chapters", bookId], queryFn: () => api.getChapters(bookId!) });
  const bookmark = useQuery({ queryKey: ["reading-position", bookId, scope], queryFn: () => api.getReadingPosition(bookId!), staleTime: 0 });
  const paragraphs: Paragraph[] = source.data && source.data.book.id === bookId ? source.data.paragraphs : [];
  const sourceKey = paragraphs.map((paragraph) => `${paragraph.id}:${paragraph.text}`).join("\u0000");
  const chunk = chunks[index];
  const progressSource = useMemo(() => {
    let total = 0;
    const offsets = new Map<string, number>();
    for (const paragraph of paragraphs) {
      offsets.set(paragraph.id, total);
      total += Array.from(paragraph.text).length;
    }
    return { total, offsets };
  }, [sourceKey]);
  const sourceProgress = chunk && progressSource.total && progressSource.offsets.has(chunk.paragraphId)
    ? Math.min(100, (progressSource.offsets.get(chunk.paragraphId)! + chunk.end) / progressSource.total * 100).toFixed(2) : null;
  const bookSource = source.data?.reading_progress;
  const bookAnchor = bookSource?.paragraphs.find((item) => item.paragraph_id === chunk?.paragraphId);
  const bookProgress = chunk && bookAnchor && bookSource?.total_characters
    ? Math.min(100, (bookAnchor.start_character + chunk.end) / bookSource.total_characters * 100).toFixed(2) : null;
  const sourceProgressLabel = unitId ? "本单元进度" : "本章进度";
  const progress = prefs.progressScope === "book" ? bookProgress : sourceProgress;
  const progressLabel = prefs.progressScope === "book" ? "全书进度" : sourceProgressLabel;
  const active = snapshot.status === "playing" || snapshot.status === "loading";
  const covered = prefs.covered;
  const width = native() ? viewport.width : Math.min(prefs.width, viewport.width - 16);
  const height = Math.max(36, Math.ceil(prefs.fontSize * 1.5 + 12));
  const x = Math.max(0, Math.min(position.x, viewport.width - width));
  const pauseForAnnotation = useCallback(() => {
    autoStart.current = false;
    pausedForSelection.current = true;
    if (["playing", "loading"].includes(snapshotRef.current.status)) player.current?.pause();
  }, []);
  const annotation = useCompactAnnotation({ text, chunk, paragraphs, disabled: covered || menu, bookId, pause: pauseForAnnotation, notify: setNotice });
  const extraHeight = menu ? 390 : annotation.isOpen ? 280 : 0;
  const y = Math.max(0, Math.min(position.y, viewport.height - height - Math.min(extraHeight, viewport.height - height)));
  const paragraph = paragraphs.find((item) => item.id === chunk?.paragraphId);
  const currentChapterId = chapterId || source.data?.chapter.id;
  const chapterList = directory.data?.chapters ?? [];

  useEffect(() => {
    if (!chunk || !bookId || !currentChapterId || !bookmark.isFetched) return;
    const paragraph = paragraphs.find((item) => item.id === chunk.paragraphId);
    rememberReadingPosition(bookId, { chapter_id: currentChapterId, reading_unit_id: unitId ?? null,
      paragraph_id: chunk.paragraphId, character_offset: chunk.start, section_ordinal: null,
      anchor_progress: paragraph ? chunk.start / Math.max(1, Array.from(paragraph.text).length) : 0 });
  }, [bookId, currentChapterId, unitId, chunk?.paragraphId, chunk?.start, bookmark.isFetched]);
  useEffect(() => () => { void flushReadingPositions(); }, []);

  useEffect(() => {
    // Entry anchors are consumed once; refreshing later must restore the latest position.
    if (search.has("paragraph") || search.has("offset") || location.state?.autoPlay || location.state?.startAtEnd || location.state?.resetPosition) navigate(location.pathname, { replace: true, state: null });
  }, []);

  const persist = useCallback((value: CompactPreferences) => {
    // A departing source must not overwrite anchors saved by another source.
    const merged = { ...value, positions: { ...loadCompact().positions, ...(value.positions[scope] ? { [scope]: value.positions[scope] } : {}) } };
    try { localStorage.setItem(compactKey, JSON.stringify(merged)); } catch { setNotice("阅读位置暂时无法保存。"); }
    window.duobookDesktop?.saveCompactPreferences(merged).catch(() => setNotice("阅读位置未能持久保存。"));
  }, [scope]);

  useEffect(() => {
    const value = { ...prefs, x: position.x, y: position.y, positions: { ...prefs.positions, ...(anchor.current ? { [scope]: anchor.current } : {}) } };
    const timer = window.setTimeout(() => persist(value), 180);
    const flush = () => persist(value);
    window.addEventListener("pagehide", flush);
    return () => { clearTimeout(timer); window.removeEventListener("pagehide", flush); persist(value); };
  }, [prefs, position, scope, index, chunks, persist]);

  useEffect(() => {
    let cancelled = false;
    window.duobookDesktop?.getSpeechSettings().then((saved) => { if (saved && !cancelled && !changedSettings.current) setSettings(saved); }).catch(() => setNotice("语音偏好读取失败。"));
    const refresh = () => setVoices(window.speechSynthesis?.getVoices().filter((voice) => voice.localService) ?? []);
    refresh(); window.speechSynthesis?.addEventListener("voiceschanged", refresh);
    return () => { cancelled = true; window.speechSynthesis?.removeEventListener("voiceschanged", refresh); };
  }, []);

  useLayoutEffect(() => {
    const element = text.current;
    if (!element || !paragraphs.length || !bookmark.isFetched) return;
    if (!bookmarkApplied.current) {
      bookmarkApplied.current = true;
      const saved = bookmark.data?.position;
      if (!explicitEntry.current && saved?.paragraph_id && saved.chapter_id === currentChapterId && (saved.reading_unit_id ?? null) === (unitId ?? null)) {
        anchor.current = { paragraphId: saved.paragraph_id, offset: saved.character_offset };
      }
    }
    let lastSignature = "";
    const rebuild = () => {
      const style = getComputedStyle(element);
      const font = `${style.fontSize} ${style.fontFamily}`;
      const available = element.clientWidth;
      if (available < 16) return;
      const signature = `${available}:${font}`;
      if (signature === lastSignature) return;
      lastSignature = signature;
      const wasActive = ["playing", "loading", "paused"].includes(snapshotRef.current.status);
      player.current?.stop();
      const next = lineChunks(paragraphs, available, font);
      const nextIndex = startAtEnd.current ? Math.max(0, next.length - 1) : anchorIndex(next, anchor.current);
      startAtEnd.current = false;
      if (!anchor.current && next[nextIndex]) anchor.current = { paragraphId: next[nextIndex].paragraphId, offset: next[nextIndex].start };
      setIndex(nextIndex); setChunks(next);
      setSnapshot({ ...idleSpeech, status: wasActive ? "paused" : "idle" });
    };
    rebuild();
    const observer = new ResizeObserver(rebuild); observer.observe(element);
    void document.fonts.ready.then(rebuild);
    return () => observer.disconnect();
  }, [sourceKey, prefs.fontSize, bookmark.isFetched]);

  useEffect(() => {
    const instance = new ReaderSpeechPlayer(chunks, (next) => {
      snapshotRef.current = next; setSnapshot(next);
      if (["loading", "playing", "paused"].includes(next.status) && chunks[next.index]) {
        const current = chunks[next.index];
        anchor.current = { paragraphId: current.paragraphId, offset: current.start };
        setIndex(next.index);
      }
      if (next.status === "finished" && prefsRef.current.continuous && !prefsRef.current.covered && !pausedForSelection.current) autoAdvance.current();
    });
    player.current = instance;
    if (autoStart.current && chunks.length && !prefsRef.current.covered && document.documentElement.dataset.compactWindowHidden !== "true") {
      autoStart.current = false;
      instance.start(indexRef.current, settingsRef.current);
    }
    return () => { instance.dispose(); player.current = null; };
  }, [chunks]);

  const setPreference = (update: Partial<CompactPreferences>) => setPrefs((value) => ({ ...value, ...update }));
  const setSpeech = (update: Partial<SpeechSettings>) => {
    changedSettings.current = true;
    const next = { ...settings, ...update };
    setSettings(next);
    try { localStorage.setItem("logic-reading-speech", JSON.stringify(next)); } catch { setNotice("语音偏好未能保存。"); }
    window.duobookDesktop?.saveSpeechSettings(next).catch(() => setNotice("语音偏好未能持久保存。"));
    if (update.rate !== undefined) player.current?.setRate(update.rate);
    else player.current?.stop();
  };
  const moveSource = (id: string, isUnit: boolean, playing = active, atEnd = false) => {
    player.current?.stop(); setMenu(false); annotation.clear();
    const path = `/compact/books/${bookId}/${isUnit ? "units" : "chapters"}/${id}`;
    navigate(path, { replace: true, state: { autoPlay: playing, startAtEnd: atEnd, resetPosition: true } });
  };
  const adjacent = (direction: number) => {
    if (unitId && source.data && "unit" in source.data) {
      const units = source.data.chapter.units;
      const at = units.findIndex((item) => item.id === unitId);
      if (units[at + direction]) return { id: units[at + direction].id, unit: true };
    }
    const at = chapterList.findIndex((item) => item.id === currentChapterId);
    if (at < 0) return null;
    const chapter = chapterList[at + direction];
    if (!chapter) return null;
    if (unitId && chapter.units.length) return { id: (direction > 0 ? chapter.units[0] : chapter.units[chapter.units.length - 1]).id, unit: true };
    return { id: chapter.id, unit: false };
  };
  autoAdvance.current = () => { const next = adjacent(1); if (next) moveSource(next.id, next.unit, true); };
  const jump = (nextIndex: number) => {
    const next = chunks[nextIndex];
    if (!next || covered) return;
    const wasActive = active;
    annotation.clear();
    player.current?.stop();
    anchor.current = { paragraphId: next.paragraphId, offset: next.start };
    setIndex(nextIndex); setNotice("");
    if (wasActive) player.current?.start(nextIndex, settings);
    else setSnapshot({ ...idleSpeech, status: snapshot.status === "paused" ? "paused" : "idle" });
  };
  const step = (direction: number) => {
    if (covered || !chunks.length) return;
    const nextIndex = index + direction;
    if (nextIndex >= 0 && nextIndex < chunks.length) { jump(nextIndex); return; }
    const next = adjacent(direction);
    if (next) moveSource(next.id, next.unit, active, direction < 0);
    else setNotice(directory.isPending ? "目录加载中…" : direction > 0 ? "已到全文末尾" : "已到开头");
  };
  const toggle = () => {
    if (covered || annotation.isOpen || document.documentElement.dataset.compactWindowHidden === "true" || !chunks.length) return;
    pausedForSelection.current = false;
    setNotice("");
    if (active) player.current?.pause();
    else if (snapshot.status === "paused" && snapshot.paragraphId) player.current?.resume();
    else player.current?.start(index, settings);
  };
  const cover = () => { autoStart.current = false; player.current?.stop(); setMenu(false); annotation.clear(); setPreference({ covered: true }); };
  useEffect(() => {
    const visibility = (event: Event) => {
      autoStart.current = false;
      player.current?.stop(); setMenu(false); annotation.clear();
      setPreference({ covered: (event as CustomEvent<{ hidden: boolean }>).detail.hidden });
      window.getSelection()?.removeAllRanges();
    };
    window.addEventListener("compact-window-visibility", visibility);
    return () => window.removeEventListener("compact-window-visibility", visibility);
  }, []);
  const returnPath = `/books/${bookId}/${unitId ? "units" : "chapters"}/${unitId || chapterId}${chunk ? `#paragraph-${chunk.paragraphId}` : ""}`;
  const leave = async () => {
    player.current?.stop(); annotation.clear();
    await flushReadingPositions();
    if (window.duobookDesktop) { try { await window.duobookDesktop.closeCompactReader(returnPath); } catch { setNotice("返回阅读页失败，请重试。"); } }
    else navigate(returnPath, { replace: true });
  };

  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (!window.duobookDesktop) return;
    void window.duobookDesktop.setCompactWindow({ width: prefs.width, height: height + extraHeight, alwaysOnTop: prefs.alwaysOnTop, returnPath }).catch(() => setNotice("窗口设置未能应用。"));
  }, [prefs.width, prefs.alwaysOnTop, height, extraHeight, returnPath]);
  useEffect(() => {
    const blur = () => { if (prefsRef.current.coverOnBlur) cover(); };
    const hidden = () => { if (document.hidden && prefsRef.current.coverOnBlur) cover(); };
    window.addEventListener("blur", blur); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", hidden); };
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); cover(); return; }
      if (covered || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || (event.target as HTMLElement)?.closest("input,select,textarea,[contenteditable=true]")) return;
      if (["ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(event.key)) { event.preventDefault(); step(event.key === "ArrowRight" || event.key === "PageDown" ? 1 : -1); }
      if (event.code === "Space" && !menu && !annotation.isOpen) { event.preventDefault(); toggle(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !menuButton.current?.contains(event.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const scroll = (event: WheelEvent) => {
      if (event.ctrlKey || covered || annotation.isOpen) return;
      event.preventDefault();
      const now = performance.now();
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      const value = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 200 : 1);
      if (now - wheel.current.last > 180 || Math.sign(value) !== Math.sign(wheel.current.accumulated)) wheel.current.accumulated = 0;
      wheel.current.last = now;
      wheel.current.accumulated += value;
      if (Math.abs(wheel.current.accumulated) >= 45 && now - wheel.current.changed > 350) {
        step(wheel.current.accumulated > 0 ? 1 : -1);
        wheel.current.accumulated = 0; wheel.current.changed = now;
      }
    };
    element.addEventListener("wheel", scroll, { passive: false });
    return () => element.removeEventListener("wheel", scroll);
  });

  const status = source.isPending ? "资料加载中…" : source.isError || (source.data && source.data.book.id !== bookId) ? "资料加载失败，请重试" : snapshot.status === "error" ? "语音失败，可重试或切换本地语音" : notice || (snapshot.status === "loading" ? "正在生成语音…" : snapshot.status === "paused" ? "已暂停" : snapshot.status === "finished" ? "本章 / 单元已读完" : "");
  return <div className={`compact-stage ${native() ? "compact-stage--native" : ""}`} style={{ zIndex: prefs.alwaysOnTop ? 10000 : 1 }}>
    <div className={`compact-reader ${menu ? "has-menu" : ""} ${covered ? "is-covered" : ""}`} style={{ width, left: native() ? 0 : x, top: native() ? 0 : y, fontSize: prefs.fontSize, zIndex: prefs.alwaysOnTop ? 10000 : 1, backgroundColor: `rgba(250, 250, 248, ${1 - prefs.backgroundTransparency / 100})`, borderColor: `rgba(217, 221, 215, ${1 - prefs.backgroundTransparency / 100})`, boxShadow: native() ? "none" : `0 3px 15px rgba(24, 46, 35, ${0.06 * (1 - prefs.backgroundTransparency / 100)})` }}>
      <div className="compact-reader__row" ref={row} style={{ height }} role="region" aria-label="单行悬浮阅读">
        <button className="compact-reader__grip" aria-label="拖动阅读条" title="拖动阅读条" onKeyDown={(event) => { if (!native() && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setPosition({ x: Math.max(0, x + (event.key === "ArrowRight" ? 10 : event.key === "ArrowLeft" ? -10 : 0)), y: Math.max(0, y + (event.key === "ArrowDown" ? 10 : event.key === "ArrowUp" ? -10 : 0)) }); } }} onPointerDown={(event) => {
          if (native() || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, startX: x, startY: y };
        }} onPointerMove={(event) => {
          const point = drag.current; if (!point || point.pointer !== event.pointerId) return;
          setPosition({ x: Math.max(0, Math.min(viewport.width - width, point.startX + event.clientX - point.x)), y: Math.max(0, Math.min(viewport.height - height, point.startY + event.clientY - point.y)) });
        }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}><GripVertical size={16} /></button>
        <span className="compact-reader__text" ref={text} tabIndex={covered ? undefined : 0} aria-label={covered ? undefined : "单行原文"} onPointerDown={annotation.pauseSelection} onMouseUp={annotation.capture} onKeyUp={annotation.capture} data-testid="compact-text" data-paragraph-id={covered ? undefined : chunk?.paragraphId} data-start={covered ? undefined : chunk?.start} data-end={covered ? undefined : chunk?.end}>
          {covered ? <button className="compact-reader__restore" onClick={() => setPreference({ covered: false })}>资料 · 点击恢复</button> : paragraph && chunk ? highlightedText(paragraph.text, paragraph.id, source.data?.annotations ?? [], chunk.start, chunk.end, true) : status || "本章暂无原文"}
        </span>
        <span className="compact-reader__percentage" data-testid={covered ? undefined : "compact-progress"} aria-hidden={covered || undefined} aria-label={covered ? undefined : progressLabel} title={covered ? undefined : `${progressLabel}：${progress === null ? "暂无进度" : `${progress}%`}（按当前行末累计原文字数）`}>{covered ? null : progress === null ? "—" : `${progress}%`}</span>
        <span className="compact-reader__indicator" aria-label="单行朗读状态" role="status" title={covered ? "已收起，声音已停止" : status || (active ? "正在朗读" : "准备朗读")}>
          {!covered && (snapshot.status === "loading" || source.isPending) ? <LoaderCircle size={13} className="spin" /> : !covered && snapshot.status === "playing" ? <Volume2 size={13} /> : !covered && (status || snapshot.status === "error") ? <span aria-hidden="true">•</span> : null}<span className="sr-only">{covered ? "已收起，声音已停止" : status || (active ? "正在朗读" : "准备朗读")}</span>
        </span>
        <div className="compact-reader__controls" style={{ visibility: covered ? "hidden" : undefined }}>
          <button aria-label="上一行" aria-keyshortcuts="ArrowLeft PageUp" title="上一行 · ← / Page Up" onClick={() => step(-1)} disabled={!chunks.length}><ChevronLeft size={16} /></button>
          <button aria-label={active ? "暂停朗读" : snapshot.status === "paused" ? "继续朗读" : "开始朗读"} title="播放 / 暂停 · 空格" onClick={toggle} disabled={!chunks.length}>{active ? <Pause size={14} /> : <Play size={14} />}</button>
          <button aria-label="下一行" aria-keyshortcuts="ArrowRight PageDown" title="下一行 · → / Page Down" onClick={() => step(1)} disabled={!chunks.length}><ChevronRight size={16} /></button>
        </div>
        <button className="compact-reader__pin" aria-label={native() ? "窗口置顶" : "页面内置顶"} aria-pressed={prefs.alwaysOnTop} title={native() ? "窗口置顶" : "页面内置顶（无法置于其他应用之上）"} onClick={() => setPreference({ alwaysOnTop: !prefs.alwaysOnTop })}><Pin size={14} /></button>
        <button ref={menuButton} className="compact-reader__more" aria-label="更多阅读设置" aria-expanded={menu} title="更多设置" onClick={() => { annotation.clear(); setMenu(!menu); }}><MoreHorizontal size={17} /></button>
      </div>
      {annotation.panel}
      {menu ? <div ref={panel} className="compact-reader__panel" role="dialog" aria-label="单行阅读设置">
        <div className="compact-reader__panel-heading"><strong>阅读设置</strong><button aria-label="关闭阅读设置" onClick={() => { setMenu(false); menuButton.current?.focus(); }}><X size={16} /></button></div>
        <p className="compact-reader__shortcuts">← / Page Up 上一行 · → / Page Down 下一行 · 空格 播放 / 暂停 · Esc 收起</p>
        <CompactShortcutSettings />
        {!covered && <p className="compact-reader__progress">全书进度 {bookProgress === null ? "—" : `${bookProgress}%`} · {sourceProgressLabel} {sourceProgress === null ? "—" : `${sourceProgress}%`} · {chunks.length ? `${index + 1} / ${chunks.length} 屏 · 第 ${chunk?.ordinal} 段` : "暂无原文"} · {source.data?.chapter.title}</p>}
        {!covered && status ? <p role="status">{status}{snapshot.error ? `：${snapshot.error}` : ""}</p> : null}
        {source.isError || directory.isError ? <button onClick={() => { void source.refetch(); void directory.refetch(); }}>重新加载资料</button> : null}
        <div className="compact-reader__settings">
          <label>进度显示<select aria-label="进度显示" value={prefs.progressScope} onChange={(event) => setPreference({ progressScope: event.target.value as "book" | "source" })}><option value="book">全书进度</option><option value="source">{sourceProgressLabel}</option></select></label>
          <label>语音模型<select aria-label="语音模型" value={settings.provider} onChange={(event) => setSpeech({ provider: event.target.value as SpeechSettings["provider"] })}><option value="local">本地系统语音</option><option value="mimo">小米 MiMo · V2.5 TTS</option></select></label>
          <label>音色<select aria-label="朗读音色" value={settings.provider === "mimo" ? settings.mimoVoice : settings.localVoice} onChange={(event) => setSpeech(settings.provider === "mimo" ? { mimoVoice: event.target.value } : { localVoice: event.target.value })}>{settings.provider === "mimo" ? MIMO_VOICES.map((voice) => <option key={voice} value={voice}>{voice === "mimo_default" ? "MiMo 默认音色" : voice}</option>) : <><option value="">本机默认中文声音</option>{voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}</option>)}</>}</select></label>
          <label>声调<select aria-label="朗读声调" value={settings.tone} onChange={(event) => setSpeech({ tone: event.target.value as SpeechSettings["tone"] })}><option value="low">低沉</option><option value="natural">自然</option><option value="bright">明亮</option></select></label>
          <label>语速 {settings.rate.toFixed(1)}×<input aria-label="朗读语速" type="range" min="0.5" max="2" step="0.1" value={settings.rate} onChange={(event) => setSpeech({ rate: Number(event.target.value) })} /></label>
          <label>窗口宽度 {prefs.width}px<input aria-label="单行窗口宽度" type="range" min="320" max="1200" step="20" value={prefs.width} onChange={(event) => setPreference({ width: Number(event.target.value) })} /></label>
          <label>字号 {prefs.fontSize}px<input aria-label="单行字号" type="range" min="12" max="20" step="1" value={prefs.fontSize} onChange={(event) => setPreference({ fontSize: Number(event.target.value) })} /></label>
          <label className="compact-reader__transparency">背景透明度 <span>{prefs.backgroundTransparency}%</span><input aria-label="背景透明度" aria-valuetext={`${prefs.backgroundTransparency}%`} type="range" min="0" max="100" step="5" value={prefs.backgroundTransparency} onChange={(event) => setPreference({ backgroundTransparency: Number(event.target.value) })} /><small>0% 不透明，100% 全透明；文字保持清晰</small></label>
        </div>
        <label className="compact-reader__check"><input type="checkbox" checked={prefs.continuous} onChange={(event) => setPreference({ continuous: event.target.checked })} />连续朗读下一章 / 单元</label>
        <label className="compact-reader__check"><input type="checkbox" checked={prefs.coverOnBlur} onChange={(event) => setPreference({ coverOnBlur: event.target.checked })} />失焦自动收起</label>
        <label className="compact-reader__check"><input type="checkbox" checked={prefs.alwaysOnTop} onChange={(event) => setPreference({ alwaysOnTop: event.target.checked })} />{native() ? "窗口置顶" : "页面内置顶"}</label>
        {!native() ? <p>网页置顶仅在当前页面内生效；跨应用置顶请使用桌面版。</p> : null}
        {!covered ? <label className="compact-reader__chapter">选择章节<select aria-label="选择章节" value={currentChapterId ?? ""} onChange={(event) => moveSource(event.target.value, false)}>{chapterList.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.ordinal}. {chapter.title}</option>)}</select></label> : null}
        <div className="compact-reader__menu-actions">
          {snapshot.status === "error" && !covered ? <button onClick={toggle}>重试朗读</button> : null}
          {!covered ? <><button onClick={() => { const ids = [...new Set(chunks.map((part) => part.paragraphId))]; const at = ids.indexOf(chunk?.paragraphId ?? ""); const next = chunks.findIndex((part) => part.paragraphId === ids[at + 1]); if (next >= 0) jump(next); else { const source = adjacent(1); if (source) moveSource(source.id, source.unit); else setNotice("已到全文末尾"); } }}>下一段</button><button onClick={() => { const ids = [...new Set(chunks.map((part) => part.paragraphId))]; const at = ids.indexOf(chunk?.paragraphId ?? ""); if (at > 0) jump(chunks.findIndex((part) => part.paragraphId === ids[at - 1])); else { const source = adjacent(-1); if (source) moveSource(source.id, source.unit, active, true); else jump(0); } }}>上一段</button></> : null}
          <button onClick={() => player.current?.stop()}>停止朗读</button><button onClick={cover}>收起 · Esc</button>
          <button className="compact-reader__return" onClick={leave}><ArrowUpRight size={14} />返回完整阅读</button>
        </div>
      </div> : null}
    </div>
  </div>;
}
