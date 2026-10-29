import { BookOpen, LoaderCircle, TriangleAlert } from "lucide-react";
import type { Book } from "../types";

export function StatusBadge({ book }: { book: Book }) {
  if (book.status === "ready") {
    return (
      <span className="status-badge status-badge--ready">
        <BookOpen size={14} />
        可阅读
      </span>
    );
  }
  if (book.status === "failed" || book.status === "failed_partial") {
    return (
      <span className="status-badge status-badge--danger">
        <TriangleAlert size={14} />
        {book.status === "failed_partial" ? "部分失败" : "生成失败"}
      </span>
    );
  }
  return (
    <span className="status-badge status-badge--processing">
      <LoaderCircle className="spin" size={14} />
      {book.status === "awaiting_structure_confirmation" ? "待确认目录" : "处理中"}
    </span>
  );
}
