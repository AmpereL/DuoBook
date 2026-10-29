import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Background, Controls, Handle, Position, ReactFlow, type Node, type NodeProps, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Link, useParams } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { api } from "../api";

type MapData = { title: string; href?: string; status?: string; action?: () => void; disabled?: boolean; root?: boolean };
type TreeNode = Node<MapData, "reading">;

function ReadingNode({ data }: NodeProps<TreeNode>) {
  return <div className={`chapter-map-node ${data.root ? "chapter-map-node--root" : ""}`}>
    {!data.root && <Handle type="target" position={Position.Top} />}
    {data.href ? <Link className="nodrag" to={data.href}>{data.title}</Link> : <strong>{data.title}</strong>}
    {data.status && <small>{data.status}</small>}
    {data.action && <button className="nodrag" disabled={data.disabled} onClick={data.action}>{data.disabled ? "正在拆分…" : "拆分本章"}</button>}
    <Handle type="source" position={Position.Bottom} />
  </div>;
}
const nodeTypes = { reading: ReadingNode };

export function ChapterMapPage() {
  const { bookId } = useParams();
  const client = useQueryClient();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["chapters", bookId], queryFn: () => api.getChapters(bookId!), enabled: Boolean(bookId),
    refetchInterval: (q) => q.state.data?.chapters.some((c) => c.status === "splitting") ? 800 : false,
  });
  const split = async (id: string) => {
    setError(""); setPending((s) => new Set(s).add(id));
    try {
      await api.splitChapter(bookId!, id);
      await client.invalidateQueries({ queryKey: ["chapters", bookId] });
      await client.invalidateQueries({ queryKey: ["chapter", bookId, id] });
    } catch (e) { setError(e instanceof Error ? e.message : "拆分失败，请重试"); }
    finally { setPending((s) => { const next = new Set(s); next.delete(id); return next; }); }
  };
  const graph = useMemo(() => {
    const nodes: TreeNode[] = [], edges: Edge[] = [];
    let y = 0;
    for (const chapter of query.data?.chapters ?? []) {
      const height = Math.max(320, chapter.units.length * 320);
      const busy = chapter.status === "splitting" || pending.has(chapter.id);
      nodes.push({ id: chapter.id, type: "reading", position: { x: y + (height - 320) / 2, y: 220 }, data: {
        title: chapter.title, href: `/books/${bookId}/chapters/${chapter.id}`,
        status: busy ? `正在拆分 ${chapter.job?.progress ?? 0}%` : chapter.status === "failed" ? `拆分失败：${chapter.job?.error ?? "请重试"}` : chapter.units.length ? `${chapter.units.length} 个阅读单元` : "未拆分",
        action: chapter.units.length ? undefined : () => { void split(chapter.id); }, disabled: busy,
      } });
      edges.push({ id: `book-${chapter.id}`, source: "book", target: chapter.id, type: "smoothstep" });
      chapter.units.forEach((unit, index) => {
        nodes.push({ id: unit.id, type: "reading", position: { x: y + index * 320, y: 470 }, data: {
          title: `${unit.ordinal}. ${unit.title}`, href: `/books/${bookId}/units/${unit.id}`, status: "点击阅读原文",
        } });
        edges.push({ id: `${chapter.id}-${unit.id}`, source: chapter.id, target: unit.id, type: "smoothstep" });
      });
      y += height + 40;
    }
    nodes.unshift({ id: "book", type: "reading", position: { x: Math.max(0, (y - 360) / 2), y: 0 }, data: { title: query.data?.book.title ?? "书籍", root: true } });
    return { nodes, edges };
  }, [query.data, pending, bookId]);
  return <div className="chapter-map-page">
    <AppHeader />
    <header className="chapter-map-toolbar"><div><h1>逻辑地图</h1><p>{query.data?.book.title} · 从上到下：书籍 → 章节 → 阅读单元。拖动画布查看其他章节。</p></div><Link className="button button--secondary" to={`/books/${bookId}`}>章节工作台</Link></header>
    {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}
    {query.isLoading ? <p role="status">正在加载章节…</p> : <div className="chapter-map-canvas">
      <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} fitView minZoom={0.08} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false} panOnScroll zoomOnScroll={false} zoomOnPinch fitViewOptions={{ padding: 0.15, minZoom: 0.85, maxZoom: 1 }}>
        <Background /><Controls showInteractive={false} />
      </ReactFlow>
    </div>}
  </div>;
}
