import { api } from "./api";
import type { Paragraph } from "./types";

export type SpeechTone = "low" | "natural" | "bright";
export type SpeechSettings = {
  provider: "local" | "mimo";
  localVoice: string;
  mimoVoice: string;
  rate: number;
  tone: SpeechTone;
};
export type SpeechChunk = { paragraphId: string; ordinal: number; start: number; end: number; text: string };
export type SpeechSnapshot = {
  status: "idle" | "loading" | "playing" | "paused" | "finished" | "error";
  index: number;
  paragraphId: string | null;
  error: string;
};
export const defaultSpeechSettings: SpeechSettings = { provider: "local", localVoice: "", mimoVoice: "mimo_default", rate: 1, tone: "natural" };
export const MIMO_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];
export const idleSpeech: SpeechSnapshot = { status: "idle", index: 0, paragraphId: null, error: "" };

export function loadSpeechSettings(): SpeechSettings {
  try {
    const saved = JSON.parse(localStorage.getItem("logic-reading-speech") || "{}");
    return {
      provider: saved.provider === "mimo" ? "mimo" : "local",
      localVoice: typeof saved.localVoice === "string" ? saved.localVoice : "",
      mimoVoice: MIMO_VOICES.includes(saved.mimoVoice) ? saved.mimoVoice : "mimo_default",
      rate: typeof saved.rate === "number" && saved.rate >= 0.5 && saved.rate <= 2 ? saved.rate : 1,
      tone: ["low", "natural", "bright"].includes(saved.tone) ? saved.tone : "natural",
    };
  } catch { return { ...defaultSpeechSettings }; }
}

export function speechChunks(paragraphs: Paragraph[]): SpeechChunk[] {
  return paragraphs.flatMap((paragraph) => {
    const characters = Array.from(paragraph.text);
    const result: SpeechChunk[] = [];
    for (let start = 0; start < characters.length;) {
      let end = Math.min(start + 240, characters.length);
      if (end < characters.length) {
        for (let boundary = end - 1; boundary > start + 100; boundary--) {
          if (/[。！？!?；;\n]/.test(characters[boundary])) { end = boundary + 1; break; }
        }
      }
      const text = characters.slice(start, end).join("");
      if (text.trim()) result.push({ paragraphId: paragraph.id, ordinal: paragraph.ordinal, start, end, text });
      start = end;
    }
    return result;
  });
}

type AudioResult = { blob: Blob; error?: never } | { error: Error; blob?: never };

const players = new Set<ReaderSpeechPlayer>();
let speechChannel: BroadcastChannel | null = null;
function channel() {
  if (!speechChannel && typeof BroadcastChannel !== "undefined") {
    speechChannel = new BroadcastChannel("logic-reading-speech");
    speechChannel.onmessage = () => { for (const player of players) player.stop(); };
  }
  return speechChannel;
}
export function stopReadingSpeech() {
  for (const player of players) player.stop();
  channel()?.postMessage("stop");
}

export class ReaderSpeechPlayer {
  private epoch = 0;
  private disposed = false;
  private paused = false;
  private index = 0;
  private pendingIndex: number | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private utterance: SpeechSynthesisUtterance | null = null;
  private controllers = new Set<AbortController>();
  private cache = new Map<number, Promise<AudioResult>>();
  private settings = { ...defaultSpeechSettings };
  private snapshot = { ...idleSpeech };

  constructor(readonly chunks: SpeechChunk[], private onChange: (snapshot: SpeechSnapshot) => void) { players.add(this); channel(); }

  private emit(status: SpeechSnapshot["status"], error = "") {
    this.snapshot = { status, index: this.index, error, paragraphId: ["loading", "playing", "paused"].includes(status) ? this.chunks[this.index]?.paragraphId ?? null : null };
    if (!this.disposed) this.onChange(this.snapshot);
  }

  private clearAudio() {
    if (this.audio) {
      this.audio.onended = this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.audio = null;
    }
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = null;
  }

  private cleanup() {
    this.epoch++;
    this.clearAudio();
    if (this.utterance) {
      this.utterance.onend = this.utterance.onerror = this.utterance.onstart = null;
      window.speechSynthesis?.cancel();
      this.utterance = null;
    }
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.cache.clear();
    this.pendingIndex = null;
    this.paused = false;
  }

  stop() { this.cleanup(); this.emit("idle"); }
  dispose() { this.disposed = true; this.cleanup(); players.delete(this); }

  start(index: number, settings: SpeechSettings) {
    for (const player of players) if (player !== this) player.stop();
    channel()?.postMessage("stop");
    this.cleanup();
    this.settings = { ...settings };
    void this.read(index, this.epoch);
  }

  pause() {
    this.paused = true;
    this.audio?.pause();
    if (this.utterance) window.speechSynthesis.pause();
    this.emit("paused");
  }

  resume() {
    this.paused = false;
    if (this.pendingIndex !== null) {
      const next = this.pendingIndex;
      this.pendingIndex = null;
      void this.read(next, this.epoch);
    } else if (this.audio) {
      void this.playAudio(this.audio, this.epoch);
    } else if (this.utterance) {
      window.speechSynthesis.resume();
      this.emit("playing");
    } else this.emit("loading");
  }

  setRate(rate: number) {
    this.settings.rate = rate;
    if (this.audio) this.audio.playbackRate = rate;
    if (this.utterance) {
      const wasPaused = this.paused;
      this.start(this.index, this.settings);
      if (wasPaused) this.pause();
    }
  }

  private fail(error: unknown) {
    this.cleanup();
    this.emit("error", error instanceof Error ? error.message : "朗读失败，请重试或切换语音模型。");
  }

  private fetchAudio(index: number): Promise<AudioResult> {
    const cached = this.cache.get(index);
    if (cached) return cached;
    const chunk = this.chunks[index];
    const controller = new AbortController();
    this.controllers.add(controller);
    const promise = api.synthesizeSpeech({ paragraph_id: chunk.paragraphId, start_offset: chunk.start, end_offset: chunk.end, voice: this.settings.mimoVoice, tone: this.settings.tone }, controller.signal)
      .then((blob): AudioResult => ({ blob }))
      .catch((error): AudioResult => ({ error: error instanceof Error ? error : new Error("语音生成失败") }))
      .finally(() => this.controllers.delete(controller));
    this.cache.set(index, promise);
    return promise;
  }

  private prefetch() {
    if (!this.paused && this.index + 1 < this.chunks.length) void this.fetchAudio(this.index + 1);
  }

  private async playAudio(audio: HTMLAudioElement, epoch: number) {
    try {
      await audio.play();
      if (epoch !== this.epoch || audio !== this.audio) return;
      if (this.paused) { audio.pause(); return; }
      this.emit("playing");
      this.prefetch();
    } catch {
      if (epoch === this.epoch && !this.paused) this.fail(new Error("浏览器未能播放语音，请点击开始重试或切换到本地语音。"));
    }
  }

  private async read(index: number, epoch: number) {
    if (epoch !== this.epoch || this.disposed) return;
    if (index >= this.chunks.length) { this.cleanup(); this.emit("finished"); return; }
    this.index = index;
    if (this.paused) { this.pendingIndex = index; return; }
    this.emit("loading");
    const chunk = this.chunks[index];
    try {
      if (this.settings.provider === "local") {
        if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) throw new Error("当前环境不支持本地语音，请切换到小米 MiMo。");
        const voices = window.speechSynthesis.getVoices().filter((voice) => voice.localService);
        const voice = voices.find((voice) => voice.voiceURI === this.settings.localVoice) ?? voices.find((voice) => /^zh/i.test(voice.lang)) ?? voices[0];
        if (!voice) throw new Error("未发现本地语音，请在 macOS 系统设置的辅助功能中下载朗读声音，或切换到小米 MiMo。");
        const utterance = new SpeechSynthesisUtterance(chunk.text);
        this.utterance = utterance;
        utterance.voice = voice;
        utterance.lang = voice.lang;
        utterance.rate = this.settings.rate;
        utterance.pitch = { low: 0.75, natural: 1, bright: 1.25 }[this.settings.tone];
        utterance.onstart = () => { if (epoch === this.epoch) { if (this.paused) window.speechSynthesis.pause(); else this.emit("playing"); } };
        utterance.onend = () => { if (epoch === this.epoch) { this.utterance = null; void this.read(index + 1, epoch); } };
        utterance.onerror = () => { if (epoch === this.epoch) this.fail(new Error("本地语音播放失败，请重新开始或切换到小米 MiMo。")); };
        window.speechSynthesis.speak(utterance);
      } else {
        const result = await this.fetchAudio(index);
        if (epoch !== this.epoch) return;
        if (result.error) throw result.error;
        this.audioUrl = URL.createObjectURL(result.blob);
        const audio = new Audio(this.audioUrl);
        this.audio = audio;
        audio.playbackRate = this.settings.rate;
        audio.preservesPitch = true;
        audio.onended = () => {
          if (epoch !== this.epoch) return;
          this.clearAudio();
          this.cache.delete(index);
          void this.read(index + 1, epoch);
        };
        audio.onerror = () => { if (epoch === this.epoch) this.fail(new Error("音频加载失败，请重新开始朗读。")); };
        if (!this.paused) await this.playAudio(audio, epoch);
      }
    } catch (error) { if (epoch === this.epoch) this.fail(error); }
  }
}
