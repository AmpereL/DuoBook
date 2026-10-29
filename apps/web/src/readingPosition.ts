import { api } from "./api";
import type { ReadingPositionInput } from "./types";

type PendingPosition = { value: ReadingPositionInput; timer: number | null; sentAt: number; attemptedAt: number; inFlight: Promise<unknown> | null };
const pending = new Map<string, PendingPosition>();
const producers = new Set<() => void>();
let clock = 0;

export function registerPositionProducer(producer: () => void) {
  producers.add(producer);
  return () => { producers.delete(producer); };
}

export function latestReadingPosition(bookId: string) { return pending.get(bookId)?.value; }

export function rememberReadingPosition(bookId: string, value: Omit<ReadingPositionInput, "captured_at">) {
  const previous = pending.get(bookId);
  const { captured_at: _, ...old } = previous?.value ?? {};
  if (JSON.stringify(old) === JSON.stringify(value)) return;
  clock = Math.max(Date.now(), clock + 1);
  if (previous?.timer) clearTimeout(previous.timer);
  const entry: PendingPosition = previous ?? { value: { ...value, captured_at: clock }, timer: null, sentAt: 0, attemptedAt: 0, inFlight: null };
  entry.value = { ...value, captured_at: clock };
  pending.set(bookId, entry);
  entry.timer = window.setTimeout(() => { void send(bookId); }, 300);
}

async function send(bookId: string): Promise<void> {
  const entry = pending.get(bookId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  if (entry.inFlight) { await entry.inFlight; if (entry.value.captured_at > entry.attemptedAt) await send(bookId); return; }
  if (entry.sentAt === entry.value.captured_at) return;
  const snapshot = entry.value;
  entry.attemptedAt = snapshot.captured_at;
  const task = api.saveReadingPosition(bookId, snapshot).then(() => {
    const current = pending.get(bookId);
    if (current) current.sentAt = Math.max(current.sentAt, snapshot.captured_at);
    window.dispatchEvent(new CustomEvent("reading-position-saved", { detail: { bookId } }));
  }).catch(() => {
    window.dispatchEvent(new CustomEvent("reading-position-error", { detail: { bookId } }));
  });
  entry.inFlight = task;
  await task;
  const current = pending.get(bookId);
  if (current?.inFlight === task) current.inFlight = null;
  if (current && current.value.captured_at > snapshot.captured_at) await send(bookId);
}

export async function flushReadingPositions() {
  for (const producer of producers) producer();
  await Promise.all([...pending.keys()].map(send));
}

window.addEventListener("pagehide", () => { void flushReadingPositions(); });
