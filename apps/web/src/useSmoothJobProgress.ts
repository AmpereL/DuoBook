import { useEffect, useState } from "react";
import type { Job } from "./types";

export function useSmoothJobProgress(job: Job | null | undefined): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!job || (job.status !== "running" && job.status !== "queued")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

  if (!job) return 0;
  if (job.status === "completed") return 100;
  if (job.status !== "running" && job.status !== "queued") return job.progress;
  const started = Date.parse(job.created_at);
  const elapsed = Number.isFinite(started) ? Math.max(0, now - started) : 0;
  const estimate = 8 + 84 * (1 - Math.exp(-elapsed / 90_000));
  return Math.min(92, Math.max(job.progress, Math.floor(estimate)));
}
