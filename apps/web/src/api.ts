import type {
  ApiErrorPayload,
  Book,
  Chapter,
  ChapterDetailPayload,
  ChapterListPayload,
  MapPayload,
  ModelConfiguration,
  Note,
  ReadingNoteKind,
  ReadingNoteListPayload,
  ReadingUnitPayload,
  ReadingUnitSection,
  ReaderPayload,
  SearchPayload,
  StructurePayload,
} from "./types";

export class ApiError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;

  constructor(
    message: string,
    code = "REQUEST_FAILED",
    status = 500,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  if (!response.ok) {
    let payload: ApiErrorPayload | null = null;
    try {
      payload = (await response.json()) as ApiErrorPayload;
    } catch {
      payload = null;
    }
    throw new ApiError(
      payload?.error.message ?? `请求失败 (${response.status})`,
      payload?.error.code ?? "REQUEST_FAILED",
      response.status,
      payload?.error.details ?? {},
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  getReadingPosition: (bookId: string) => request<import("./types").ReadingPositionPayload>(`/books/${bookId}/reading-position`),
  saveReadingPosition: (bookId: string, position: import("./types").ReadingPositionInput) =>
    window.duobookDesktop ? window.duobookDesktop.saveReadingPosition(bookId, position) : request<import("./types").ReadingPositionPayload>(`/books/${bookId}/reading-position`, { method: "PUT", body: JSON.stringify(position), keepalive: true }),
  speechConfiguration: () => request<{ model: string; configured: boolean; voices: string[]; base_url: string; timeout: number; credential_source: "speech" | "model" }>("/speech/config"),
  updateSpeechConfiguration: (body: { base_url: string; api_key?: string; timeout: number }) =>
    request("/speech/config", { method: "PUT", body: JSON.stringify(body) }).then(async (result) => {
      await window.duobookDesktop?.saveSpeechConfiguration(body);
      return result;
    }),
  testSpeechConfiguration: (body: { base_url: string; api_key?: string; timeout: number }) =>
    request<{ message: string; audio_bytes: number }>("/speech/test", { method: "POST", body: JSON.stringify(body) }),
  synthesizeSpeech: async (body: { paragraph_id: string; start_offset: number; end_offset: number; voice: string; tone: string }, signal: AbortSignal) => {
    const response = await fetch("/api/v1/speech/synthesize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new ApiError(payload?.error?.message ?? "语音生成失败，请重试", payload?.error?.code, response.status);
    }
    return response.blob();
  },
  getModelConfiguration: () =>
    request<ModelConfiguration>("/settings/model"),

  updateModelConfiguration: (body: {
    provider: ModelConfiguration["provider"];
    base_url: string;
    api_key?: string;
    model: string;
    timeout: number;
  }) =>
    request<ModelConfiguration>("/settings/model", {
      method: "PUT",
      body: JSON.stringify(body),
    }).then(async (result) => {
      await window.duobookDesktop?.saveModel(body);
      return result;
    }),

  testModelConfiguration: (body: {
    provider: ModelConfiguration["provider"];
    base_url: string;
    api_key?: string;
    model: string;
    timeout: number;
  }) =>
    request<{ provider: string; model: string; message: string }>("/settings/model/test", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listBooks: (query = "") =>
    request<{ items: Book[] }>(`/books${query ? `?q=${encodeURIComponent(query)}` : ""}`),

  getBook: (bookId: string) => request<Book>(`/books/${bookId}`),

  uploadBook: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ book: Book; structure: StructurePayload }>("/books/upload", {
      method: "POST",
      body: form,
    });
  },

  getStructure: (bookId: string) =>
    request<StructurePayload>(`/books/${bookId}/structure`),

  updateStructure: (
    bookId: string,
    body: {
      title: string;
      author: string;
      chapters: Array<{
        id: string;
        title: string;
        ordinal: number;
        include: boolean;
      }>;
    },
  ) =>
    request<StructurePayload>(`/books/${bookId}/structure`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  splitChapter: (bookId: string, chapterId: string) =>
    request<import("./types").Job>(`/books/${bookId}/chapters/${chapterId}/split-runs`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  getChapters: (bookId: string) =>
    request<ChapterListPayload>(`/books/${bookId}/chapters`),

  getChapter: (bookId: string, chapterId: string) =>
    request<ChapterDetailPayload>(`/books/${bookId}/chapters/${chapterId}`),

  getReadingUnit: (unitId: string) =>
    request<ReadingUnitPayload>(`/reading-units/${unitId}`),

  updateReadingUnitSection: (unitId: string, ordinal: number, body: string) =>
    request<ReadingUnitSection>(`/reading-units/${unitId}/sections/${ordinal}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    }),

  getJob: (jobId: string) => request<import("./types").Job>(`/jobs/${jobId}`),

  retryJob: (jobId: string) =>
    request<import("./types").Job>(`/jobs/${jobId}/retry`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  getMap: (bookId: string) => request<MapPayload>(`/books/${bookId}/map`),

  markExplored: (bookId: string, nodeId: string) =>
    request<void>(`/books/${bookId}/explored/${nodeId}`, { method: "POST" }),

  updateReadingState: (
    bookId: string,
    body: {
      map_version_id?: string | null;
      node_id?: string | null;
      paragraph_id?: string | null;
      path?: string[];
    },
  ) =>
    request<import("./types").ReadingState>(`/books/${bookId}/reading-state`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  getReader: (bookId: string, paragraphId: string) =>
    request<ReaderPayload>(`/books/${bookId}/paragraphs/${paragraphId}`),

  markRead: (bookId: string, paragraphId: string, read: boolean) =>
    request<{ paragraph_id: string; read: boolean }>(
      `/books/${bookId}/paragraphs/${paragraphId}/read`,
      {
        method: "PUT",
        body: JSON.stringify({ read }),
      },
    ),

  searchBook: (bookId: string, query: string) =>
    request<SearchPayload>(
      `/books/${bookId}/search?q=${encodeURIComponent(query)}`,
    ),

  listNotes: (options: { bookId?: string; kind?: ReadingNoteKind | "all" } = {}) => {
    const params = new URLSearchParams();
    if (options.bookId) params.set("book_id", options.bookId);
    if (options.kind && options.kind !== "all") params.set("kind", options.kind);
    const query = params.toString();
    return request<ReadingNoteListPayload>(`/notes${query ? `?${query}` : ""}`);
  },

  createNote: (paragraphId: string, body: string) =>
    request<Note>("/notes", {
      method: "POST",
      body: JSON.stringify({ paragraph_id: paragraphId, body }),
    }),

  createAnnotation: (body: {
    paragraph_id: string;
    start_offset: number;
    end_offset: number;
    quote: string;
    body?: string;
  }) =>
    request<import("./types").Annotation>("/annotations", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteAnnotation: (annotationId: string) =>
    request<void>(`/annotations/${annotationId}`, { method: "DELETE" }),

  updateNote: (noteId: string, body: string) =>
    request<Note>(`/notes/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    }),

  deleteNote: (noteId: string) =>
    request<void>(`/notes/${noteId}`, { method: "DELETE" }),

  deleteBook: (bookId: string) =>
    request<void>(`/books/${bookId}`, { method: "DELETE" }),

  exportUrl: (bookId: string) => `/api/v1/books/${bookId}/export`,
  exportNotesUrl: (format: "markdown" | "json") => `/api/v1/notes/export?format=${format}`,
};

export function statusLabel(book: Book): string {
  if (book.status === "ready") return "可阅读";
  if (book.status === "generating") {
    return `正在拆分章节 ${book.job?.completed_units ?? 0}/${book.job?.total_units ?? book.chapter_count}`;
  }
  if (book.status === "awaiting_structure_confirmation") return "待确认目录";
  if (book.status === "structure_confirmed") return "可选择章节";
  if (book.status === "failed_partial") return "部分章节失败";
  if (book.status === "failed") return "生成失败";
  if (book.status === "deleting") return "正在删除";
  return "处理中";
}

export function formatDate(value: string | null): string {
  if (!value) return "尚未阅读";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function excerpt(text: string, length = 86): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > length
    ? `${normalized.slice(0, length).trim()}…`
    : normalized;
}

export function nodeTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    question: "核心问题",
    theme: "论述板块",
    unit: "阅读单元",
    claim: "核心观点",
    evidence: "作者解释",
    example: "示例",
    condition: "适用条件",
  };
  return labels[type] ?? "观点";
}

export function relationLabel(type: string): string {
  const labels: Record<string, string> = {
    supports: "支持",
    refutes: "反驳",
    premise: "是前提",
    causes: "导致",
    explains: "解释",
    qualifies: "限定",
    next: "阅读顺序",
  };
  return labels[type] ?? "关联";
}
