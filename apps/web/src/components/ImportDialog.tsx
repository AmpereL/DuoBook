import { useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  FileText,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import type { Chapter, StructurePayload } from "../types";

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onOpenBook: (bookId: string) => void;
}

export function ImportDialog({
  open,
  onClose,
  onOpenBook,
}: ImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [structure, setStructure] = useState<StructurePayload | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("未知作者");
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [error, setError] = useState("");
  const [duplicateBookId, setDuplicateBookId] = useState("");

  const reset = () => {
    setFile(null);
    setStructure(null);
    setTitle("");
    setAuthor("未知作者");
    setChapters([]);
    setError("");
    setDuplicateBookId("");
  };

  const uploadMutation = useMutation({
    mutationFn: api.uploadBook,
    onSuccess: (result) => {
      setStructure(result.structure);
      setTitle(result.book.title);
      setAuthor(result.book.author);
      setChapters(result.structure.chapters);
      setError("");
    },
    onError: (caught) => {
      if (caught instanceof ApiError && caught.code === "DUPLICATE_BOOK") {
        setDuplicateBookId(String(caught.details.existing_book_id ?? ""));
        setError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "上传失败");
      }
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      if (!structure) throw new Error("尚未上传文件");
      const updated = await api.updateStructure(structure.book.id, {
        title,
        author,
        chapters: chapters.map((chapter, index) => ({
          id: chapter.id,
          title: chapter.title,
          ordinal: index + 1,
          include: true,
        })),
      });
      return { bookId: updated.book.id };
    },
    onSuccess: async ({ bookId }) => {
      await queryClient.invalidateQueries({ queryKey: ["books"] });
      onClose();
      reset();
      onOpenBook(bookId);
    },
    onError: (caught) => {
      setError(caught instanceof Error ? caught.message : "目录确认失败");
    },
  });

  if (!open) return null;

  const chooseFile = (nextFile?: File) => {
    if (!nextFile) return;
    setFile(nextFile);
    setError("");
    uploadMutation.mutate(nextFile);
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="导入书籍"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">准备按章阅读</span>
            <h2>{structure ? "确认目录" : "导入书籍"}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭导入">
            <X size={20} />
          </button>
        </header>

        {!structure ? (
          <div className="import-body">
            <button
              className={`drop-zone ${uploadMutation.isPending ? "is-loading" : ""}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                chooseFile(event.dataTransfer.files[0]);
              }}
            >
              <span className="drop-zone__icon">
                {uploadMutation.isPending ? (
                  <FileText size={27} />
                ) : (
                  <Upload size={27} />
                )}
              </span>
              <strong>
                {uploadMutation.isPending
                  ? "正在检查文件并识别目录…"
                  : "拖放 EPUB、文字型 PDF 或 TXT"}
              </strong>
              <span>单文件不超过 50 MB，解析后不超过 30 万字符</span>
              <span className="button button--secondary button--small">
                <Plus size={16} />
                选择文件
              </span>
            </button>
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              accept=".epub,.pdf,.txt"
              onChange={(event) => chooseFile(event.target.files?.[0])}
            />
            <div className="import-note">
              <BookOpen size={18} aria-hidden="true" />
              <p>
                系统会先识别目录和可读文本，再开始生成。加密文件、扫描件和损坏文件在
                AI 处理前终止。
              </p>
            </div>
            {error ? (
              <div className="inline-error" role="alert">
                <span>{error}</span>
                {duplicateBookId ? (
                  <button
                    className="text-button"
                    onClick={() => {
                      onClose();
                      reset();
                      onOpenBook(duplicateBookId);
                    }}
                  >
                    打开已有书籍
                    <ArrowRight size={15} />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="structure-step">
            <div className="field-grid">
              <label>
                <span>书名</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <label>
                <span>作者</span>
                <input
                  value={author}
                  onChange={(event) => setAuthor(event.target.value)}
                />
              </label>
            </div>
            <div className="structure-summary">
              <span>
                <Check size={16} />
                已识别 {chapters.length} 章
              </span>
              <span>
                {file?.name ?? "已完成解析"} ·{" "}
                {(structure.book.format ?? "document").toUpperCase()}
              </span>
            </div>
            <div className="chapter-editor" aria-label="章节顺序">
              {chapters.map((chapter, index) => (
                <div className="chapter-editor__row" key={chapter.id}>
                  <span className="chapter-editor__number">{index + 1}</span>
                  <input
                    value={chapter.title}
                    aria-label={`第 ${index + 1} 章标题`}
                    onChange={(event) =>
                      setChapters((current) =>
                        current.map((item) =>
                          item.id === chapter.id
                            ? { ...item, title: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <small>{chapter.paragraph_count ?? 0} 段</small>
                </div>
              ))}
            </div>
            {error ? (
              <div className="inline-error" role="alert">
                {error}
              </div>
            ) : null}
            <footer className="dialog-actions">
              <button className="button button--ghost" onClick={reset}>
                重新选择
              </button>
              <button
                className="button button--primary"
                disabled={confirmMutation.isPending || !title.trim()}
                onClick={() => confirmMutation.mutate()}
              >
                {confirmMutation.isPending ? "正在保存目录…" : "完成导入，选择章节"}
                <ArrowRight size={17} />
              </button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
