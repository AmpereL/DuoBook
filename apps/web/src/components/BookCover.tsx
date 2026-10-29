import { BookOpen } from "lucide-react";
import { useState } from "react";

interface BookCoverProps {
  title: string;
  author: string;
  subtitle?: string;
  tone?: string;
  compact?: boolean;
  coverUrl?: string | null;
}

export function BookCover({
  title,
  author,
  subtitle = "",
  tone = "sage",
  compact = false,
  coverUrl,
}: BookCoverProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (coverUrl && failedUrl !== coverUrl) {
    return <div className={`book-cover book-cover--original ${compact ? "book-cover--compact" : ""}`}>
      <img src={coverUrl} alt={`${title}原版封面`} loading="lazy" onError={() => setFailedUrl(coverUrl)} />
    </div>;
  }
  return (
    <div
      className={`book-cover book-cover--${tone} ${compact ? "book-cover--compact" : ""}`}
      aria-label={`${title}封面`}
    >
      <div className="book-cover__edge" />
      <div className="book-cover__mark">
        <BookOpen size={compact ? 15 : 19} aria-hidden="true" />
      </div>
      <div className="book-cover__content">
        <strong>{title}</strong>
        {!compact && subtitle ? <span>{subtitle}</span> : null}
      </div>
      <small>{author}</small>
    </div>
  );
}
