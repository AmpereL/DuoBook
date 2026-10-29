import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Pause, Play, Square, Volume2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { CompactReaderEntry } from "./CompactReaderEntry";
import type { Paragraph } from "../types";
import { idleSpeech, loadSpeechSettings, MIMO_VOICES, ReaderSpeechPlayer, speechChunks, type SpeechSettings, type SpeechSnapshot } from "../speech";

export function SpeechReader({ paragraphs, onActiveParagraph }: { paragraphs: Paragraph[]; onActiveParagraph: (id: string | null) => void }) {
  const [settings, setSettings] = useState(loadSpeechSettings);
  const [snapshot, setSnapshot] = useState<SpeechSnapshot>(idleSpeech);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [startParagraph, setStartParagraph] = useState(paragraphs[0]?.id ?? "");
  const [preferenceError, setPreferenceError] = useState("");
  const changed = useRef(false);
  const player = useRef<ReaderSpeechPlayer | null>(null);
  const sourceKey = paragraphs.map((paragraph) => `${paragraph.id}:${paragraph.text}`).join("\u0000");
  const config = useQuery({ queryKey: ["speech-configuration"], queryFn: api.speechConfiguration, enabled: settings.provider === "mimo", staleTime: 0 });

  useEffect(() => {
    const instance = new ReaderSpeechPlayer(speechChunks(paragraphs), (next) => {
      setSnapshot(next);
      onActiveParagraph(next.paragraphId);
    });
    player.current = instance;
    setSnapshot(idleSpeech);
    setStartParagraph(paragraphs[0]?.id ?? "");
    onActiveParagraph(null);
    return () => { instance.dispose(); player.current = null; };
  }, [sourceKey, onActiveParagraph]);

  useEffect(() => {
    const engine = window.speechSynthesis;
    if (!engine) return;
    const refresh = () => setVoices(engine.getVoices().filter((voice) => voice.localService));
    refresh();
    engine.addEventListener("voiceschanged", refresh);
    return () => engine.removeEventListener("voiceschanged", refresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.duobookDesktop?.getSpeechSettings().then((saved) => {
      if (saved && !cancelled && !changed.current) setSettings(saved);
    }).catch(() => { if (!cancelled) setPreferenceError("语音偏好读取失败，本次仍可调整朗读设置。"); });
    return () => { cancelled = true; };
  }, []);

  const changeSettings = (update: Partial<SpeechSettings>) => {
    changed.current = true;
    const next = { ...settings, ...update };
    setSettings(next);
    try { localStorage.setItem("logic-reading-speech", JSON.stringify(next)); } catch { /* Settings still apply for this reading session. */ }
    window.duobookDesktop?.saveSpeechSettings(next).catch(() => setPreferenceError("语音偏好未能保存，本次设置仍有效。"));
    if (update.rate !== undefined) player.current?.setRate(update.rate);
    else player.current?.stop();
  };

  const active = ["playing", "loading", "paused"].includes(snapshot.status);
  const chunk = player.current?.chunks[snapshot.index];
  const toggle = () => {
    if (snapshot.status === "paused") player.current?.resume();
    else if (active) player.current?.pause();
    else {
      const index = snapshot.status === "error" ? snapshot.index : player.current?.chunks.findIndex((item) => item.paragraphId === startParagraph) ?? 0;
      player.current?.start(Math.max(0, index), settings);
    }
  };
  const statusText = snapshot.status === "loading" ? "正在生成语音…" : snapshot.status === "paused" ? "已暂停" : snapshot.status === "playing" ? "正在朗读" : snapshot.status === "finished" ? "本页原文已读完" : "按段连续朗读本页原文";

  return (
    <section className="speech-reader" aria-label="语音阅读">
      <div className="speech-reader__heading"><Volume2 size={18} /><strong>语音阅读</strong><span role="status" aria-label="朗读状态">{statusText}{active && chunk ? ` · 第 ${chunk.ordinal} 段` : ""}</span></div>
      <div className="speech-reader__settings">
        <label>语音模型<select aria-label="语音模型" value={settings.provider} onChange={(event) => changeSettings({ provider: event.target.value as SpeechSettings["provider"] })}><option value="local">本地系统语音</option><option value="mimo">小米 MiMo · V2.5 TTS</option></select></label>
        <label>音色<select aria-label="朗读音色" value={settings.provider === "mimo" ? settings.mimoVoice : settings.localVoice} onChange={(event) => changeSettings(settings.provider === "mimo" ? { mimoVoice: event.target.value } : { localVoice: event.target.value })}>
          {settings.provider === "mimo" ? MIMO_VOICES.map((voice) => <option value={voice} key={voice}>{voice === "mimo_default" ? "MiMo 默认音色" : voice}</option>) : <><option value="">本机默认中文声音</option>{voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}</>}
        </select></label>
        <label>声调<select aria-label="朗读声调" value={settings.tone} onChange={(event) => changeSettings({ tone: event.target.value as SpeechSettings["tone"] })}><option value="low">低沉</option><option value="natural">自然</option><option value="bright">明亮</option></select></label>
        <label className="speech-reader__rate"><span>语速 <output>{settings.rate.toFixed(1)}×</output></span><input type="range" aria-label="朗读语速" min="0.5" max="2" step="0.1" value={settings.rate} onChange={(event) => changeSettings({ rate: Number(event.target.value) })} /></label>
      </div>
      <div className="speech-reader__actions">
        <CompactReaderEntry paragraphId={snapshot.paragraphId} />
        <button type="button" className="button button--primary button--small" disabled={!paragraphs.length} onClick={toggle}>{snapshot.status === "loading" ? <LoaderCircle className="spin" size={15} /> : active && snapshot.status !== "paused" ? <Pause size={15} /> : <Play size={15} />}{snapshot.status === "paused" ? "继续朗读" : active ? "暂停朗读" : "开始朗读"}</button>
        <button type="button" className="button button--secondary button--small" disabled={!active} onClick={() => player.current?.stop()}><Square size={14} />停止</button>
        <label>开始段落<select aria-label="开始朗读段落" value={startParagraph} disabled={active} onChange={(event) => { setStartParagraph(event.target.value); if (snapshot.status === "error") player.current?.stop(); }}>{paragraphs.map((paragraph) => <option key={paragraph.id} value={paragraph.id}>第 {paragraph.ordinal} 段</option>)}</select></label>
      </div>
      <p className="speech-reader__hint">{settings.provider === "local" ? "使用本机已安装的系统声音，无需 API Key。" : `${config.data?.credential_source === "speech" ? "使用独立的 MiMo 语音配置。" : "当前沿用解析模型的 MiMo Key。"}声调通过合成指令调整，语速可即时调节。`} 更换模型、音色或声调会停止当前朗读。{settings.provider === "mimo" ? <Link to="/settings/model#speech-settings">语音连接设置</Link> : null}</p>
      {settings.provider === "mimo" && config.data && !config.data.configured ? <p className="inline-error">尚未配置可用的 MiMo Key，请在<Link to="/settings/model#speech-settings">语音连接设置</Link>中保存 Key。</p> : null}
      {snapshot.error ? <p className="inline-error" role="alert">{snapshot.error}</p> : null}
      {preferenceError ? <p className="inline-error" role="alert">{preferenceError}</p> : null}
    </section>
  );
}
