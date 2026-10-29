import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  GitBranch,
  Layers3,
  ListTree,
  LoaderCircle,
  LocateFixed,
  Maximize2,
  Menu,
  Network,
  RefreshCw,
} from "lucide-react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { api, ApiError, excerpt, nodeTypeLabel, relationLabel } from "../api";
import type { MapNode, MapPayload, MapRelation, Source } from "../types";

interface GraphNodeData extends Record<string, unknown> {
  kind?: "map";
  node?: MapNode;
  selected?: boolean;
}

interface SourceNodeData extends Record<string, unknown> {
  kind: "source";
  source: Source;
}

type FlowMapNode = Node<GraphNodeData, "mapNode">;
type FlowSourceNode = Node<SourceNodeData, "sourceNode">;

function MapNodeView({ data, selected }: NodeProps<FlowMapNode>) {
  const node = data.node;
  if (!node) return null;
  return (
    <div
      className={`flow-node flow-node--${node.type} ${
        selected || data.selected ? "is-selected" : ""
      }`}
      data-testid="map-flow-node"
    >
      <Handle type="target" position={Position.Top} />
      <span className="flow-node__icon">
        {node.type === "question" ? (
          <BookOpen size={20} />
        ) : node.type === "condition" ? (
          <CircleAlert size={20} />
        ) : node.type === "example" ? (
          <FileText size={20} />
        ) : (
          <Layers3 size={20} />
        )}
      </span>
      <small>{nodeTypeLabel(node.type)}</small>
      <strong>{node.title}</strong>
      <p>{excerpt(node.statement, 50)}</p>
      {node.origin === "inferred" ? <em>AI 推断</em> : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function SourceNodeView({ data, selected }: NodeProps<FlowSourceNode>) {
  const source = data.source;
  return (
    <div className={`flow-node flow-node--source ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <span className="flow-node__icon">
        <FileText size={19} />
      </span>
      <small>原文段落</small>
      <strong>
        第 {source.chapter_title} · 第 {source.paragraph_ordinal} 段
      </strong>
      <p>{excerpt(source.quote, 54)}</p>
    </div>
  );
}

const nodeTypes = {
  mapNode: MapNodeView,
  sourceNode: SourceNodeView,
};

function mapRelationLabel(relation: MapRelation): string {
  return relationLabel(relation.type);
}

function ProcessingPanel({ bookId }: { bookId: string }) {
  const queryClient = useQueryClient();
  const bookQuery = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
    refetchInterval: 700,
  });
  const book = bookQuery.data;
  const job = book?.job;
  const retryMutation = useMutation({
    mutationFn: () => api.retryJob(job!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
      queryClient.invalidateQueries({ queryKey: ["map", bookId] });
    },
  });

  if (book?.status === "ready") {
    queryClient.invalidateQueries({ queryKey: ["map", bookId] });
  }

  return (
    <main className="processing-main">
      <section className="processing-card">
        <span className="processing-card__icon">
          {book?.status === "failed" || book?.status === "failed_partial" ? (
            <CircleAlert size={28} />
          ) : (
            <LoaderCircle className="spin" size={28} />
          )}
        </span>
        <span className="eyebrow">全书逻辑地图</span>
        <h1>
          {book?.status === "failed" || book?.status === "failed_partial"
            ? "生成遇到问题"
            : "正在构建阅读地图"}
        </h1>
        <p>
          {job?.message ??
            "正在检查原文、按章节提取观点，并把引用映射回稳定段落。"}
        </p>
        <div className="job-progress">
          <i style={{ width: `${Math.max(4, job?.progress ?? 0)}%` }} />
        </div>
        <div className="job-progress__meta">
          <span>{job?.stage ?? "queued"}</span>
          <strong>{job?.progress ?? 0}%</strong>
        </div>
        {job?.error ? <pre>{job.error}</pre> : null}
        <div className="processing-card__actions">
          <Link className="button button--ghost" to="/library">
            返回书架
          </Link>
          {job?.status === "failed" ? (
            <button
              className="button button--primary"
              onClick={() => retryMutation.mutate()}
            >
              <RefreshCw size={17} />
              重试失败部分
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

export function MapPage() {
  const { bookId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [focusId, setFocusId] = useState("");
  const [showRelations, setShowRelations] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [splitJobId, setSplitJobId] = useState("");
  const initialized = useRef(false);
  const splitChapterMutation = useMutation({
    mutationFn: (chapterId: string) => api.splitChapter(bookId, chapterId),
    onSuccess: (job) => {
      setSplitJobId(job.id);
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
      queryClient.invalidateQueries({ queryKey: ["map", bookId] });
    },
  });
  const splitJobQuery = useQuery({
    queryKey: ["split-job", splitJobId],
    queryFn: () => api.getJob(splitJobId),
    enabled: Boolean(splitJobId),
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.status ?? "") ? 700 : false,
  });

  useEffect(() => {
    if (!splitJobQuery.data || !["completed", "failed"].includes(splitJobQuery.data.status)) return;
    queryClient.invalidateQueries({ queryKey: ["book", bookId] });
    queryClient.invalidateQueries({ queryKey: ["map", bookId] });
  }, [bookId, queryClient, splitJobQuery.data]);

  const mapQuery = useQuery({
    queryKey: ["map", bookId],
    queryFn: () => api.getMap(bookId),
    retry: (count, error) => {
      if (error instanceof ApiError && error.status === 409) return count < 2;
      return count < 1;
    },
  });

  const payload: MapPayload | undefined = mapQuery.data;
  const nodes = payload?.nodes ?? [];
  const root = nodes.find((node) => !node.parent_id);

  useEffect(() => {
    if (!payload || initialized.current) return;
    const requestedNode = searchParams.get("node");
    const requested = nodes.find((node) => node.id === requestedNode);
    const stateNode = nodes.find(
      (node) => node.id === payload.state?.last_node_id,
    );
    const initial = requested ?? stateNode ?? root;
    if (initial) {
      setSelectedId(initial.id);
      setFocusId(initial.id);
    }
    initialized.current = true;
  }, [nodes, payload, root, searchParams]);

  useEffect(() => {
    if (!payload || !selectedId) return;
    const path: string[] = [];
    let current = nodes.find((node) => node.id === selectedId);
    while (current) {
      path.unshift(current.id);
      current = current.parent_id
        ? nodes.find((node) => node.id === current?.parent_id)
        : undefined;
    }
    api.markExplored(bookId, selectedId).catch(() => undefined);
    api
      .updateReadingState(bookId, {
        map_version_id: payload.map_version.id,
        node_id: selectedId,
        paragraph_id: nodes.find((node) => node.id === selectedId)?.sources[0]
          ?.paragraph_id,
        path,
      })
      .then(() =>
        queryClient.invalidateQueries({ queryKey: ["books"], exact: false }),
      )
      .catch(() => undefined);
  }, [bookId, nodes, payload, queryClient, selectedId]);

  const focus =
    nodes.find((node) => node.id === focusId) ??
    root;
  const selected =
    nodes.find((node) => node.id === selectedId) ?? focus;
  const activeNode = selected ?? focus;

  const graph = useMemo(() => {
    if (!root) return { nodes: [] as FlowMapNode[], edges: [] as Edge[] };

    // Desktop shows the complete hierarchy at once. React Flow's pan and zoom
    // keep a large book navigable without hiding lower levels behind another page.
    const depthById = new Map<string, number>([[root.id, 0]]);
    const unresolved = [...nodes];
    while (unresolved.length) {
      const next = unresolved.filter((node) => {
        if (!node.parent_id || !depthById.has(node.parent_id)) return false;
        depthById.set(node.id, (depthById.get(node.parent_id) ?? 0) + 1);
        return true;
      });
      if (!next.length) break;
      for (const node of next) unresolved.splice(unresolved.indexOf(node), 1);
    }
    const levels = new Map<number, MapNode[]>();
    for (const node of nodes) {
      const depth = depthById.get(node.id) ?? 0;
      const level = levels.get(depth) ?? [];
      level.push(node);
      levels.set(depth, level);
    }
    const flowNodes: FlowMapNode[] = [];
    for (const [depth, level] of levels) {
      const ordered = level.sort((a, b) => a.ordinal - b.ordinal);
      ordered.forEach((node, index) => {
        flowNodes.push({
          id: node.id,
          type: "mapNode",
          position: {
            x: (index - (ordered.length - 1) / 2) * 254,
            y: depth * 220 + 20,
          },
          data: {
            kind: "map",
            node,
            selected: node.id === activeNode?.id,
          },
          draggable: false,
          selectable: true,
        });
      });
    }
    const flowEdges: Edge[] = nodes
      .filter((node) => node.parent_id && depthById.has(node.parent_id))
      .map((node) => ({
        id: `hierarchy-${node.parent_id}-${node.id}`,
        source: node.parent_id!,
        target: node.id,
        type: "smoothstep",
        style: { stroke: "#678071", strokeWidth: 1.25 },
      }));

    if (showRelations && payload) {
      const visibleIds = new Set(flowNodes.map((node) => node.id));
      for (const relation of payload.relations) {
        if (!visibleIds.has(relation.from_node_id) || !visibleIds.has(relation.to_node_id)) continue;
        flowEdges.push({
          id: relation.id,
          source: relation.from_node_id,
          target: relation.to_node_id,
          type: "smoothstep",
          label: mapRelationLabel(relation),
          labelStyle: { fill: "#234c3d", fontWeight: 700, fontSize: 12 },
          labelBgStyle: { fill: "#f7f7f2", fillOpacity: 0.96 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#234c3d" },
          style: {
            stroke: "#234c3d",
            strokeWidth: 1.5,
            strokeDasharray: relation.origin === "inferred" ? "7 5" : undefined,
          },
        });
      }
    }
    return { nodes: flowNodes, edges: flowEdges };
  }, [activeNode?.id, nodes, payload, root, showRelations]);

  const mobileGraph = useMemo(() => {
    const depthOf = (node: MapNode) => {
      let depth = 0;
      let current = node;
      while (current.parent_id) {
        const parent = nodes.find((candidate) => candidate.id === current.parent_id);
        if (!parent) break;
        depth += 1;
        current = parent;
      }
      return depth;
    };
    return [...nodes].sort((left, right) => {
      const depthDifference = depthOf(left) - depthOf(right);
      return depthDifference || left.ordinal - right.ordinal;
    });
  }, [nodes]);

  const focusPath = useMemo(() => {
    const path: MapNode[] = [];
    let current = activeNode;
    while (current) {
      path.unshift(current);
      current = current.parent_id
        ? nodes.find((node) => node.id === current?.parent_id)
        : undefined;
    }
    return path;
  }, [activeNode, nodes]);

  const related = useMemo(() => {
    if (!payload || !activeNode) return [];
    const relationRows = payload.relations.filter(
      (relation) =>
        relation.from_node_id === activeNode.id ||
        relation.to_node_id === activeNode.id,
    );
    return relationRows
      .map((relation) => {
        const otherId =
          relation.from_node_id === activeNode.id
            ? relation.to_node_id
            : relation.from_node_id;
        return {
          relation,
          node: nodes.find((node) => node.id === otherId),
        };
      })
      .filter((item) => item.node);
  }, [activeNode, nodes, payload]);

  if (mapQuery.isLoading) {
    return (
      <div className="app-frame">
        <AppHeader />
        <main className="processing-main">
          <div className="skeleton skeleton--map" />
        </main>
      </div>
    );
  }

  if (mapQuery.error || !payload || !focus) {
    const error = mapQuery.error;
    if (
      error instanceof ApiError &&
      (error.code === "MAP_NOT_READY" ||
        error.code === "MAP_GENERATING" ||
        error.status === 409)
    ) {
      return (
        <div className="app-frame">
          <AppHeader />
          <ProcessingPanel bookId={bookId} />
        </div>
      );
    }
    return (
      <div className="app-frame">
        <AppHeader />
        <main className="processing-main">
          <section className="processing-card">
            <CircleAlert size={28} />
            <h1>无法打开这本书</h1>
            <p>{error instanceof Error ? error.message : "书籍或地图不存在"}</p>
            <Link className="button button--primary" to="/library">
              返回书架
            </Link>
          </section>
        </main>
      </div>
    );
  }

  const themes = nodes
    .filter((node) => node.parent_id === root?.id)
    .sort((a, b) => a.ordinal - b.ordinal);
  const currentNode = activeNode ?? focus;

  return (
    <div className="app-frame app-frame--workspace">
      <AppHeader />
      <aside className={`workspace-sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="workspace-sidebar__top">
          <Link className="back-link" to="/library">
            <ArrowLeft size={17} />
            返回书架
          </Link>
          <h2>{payload.book.title}</h2>
          <span className="book-mode">原创示例</span>
        </div>
        <div className="workspace-tabs workspace-tabs--sidebar">
          <Link
            className="is-active"
            to={`/books/${bookId}/map`}
          >
            <Network size={17} />
            逻辑地图
          </Link>
          <Link
            to={
              currentNode.sources[0]
                ? `/books/${bookId}/read/${currentNode.sources[0].paragraph_id}?fromNode=${currentNode.id}`
                : "#"
            }
          >
            <BookOpen size={17} />
            原文阅读
          </Link>
        </div>
        <section className="sidebar-section">
          <h3>
            <ListTree size={16} />
            书籍结构
          </h3>
          {themes.map((theme) => (
            <button
              key={theme.id}
              className={activeNode?.id === theme.id ? "is-active" : ""}
              onClick={() => {
                setFocusId(theme.id);
                setSelectedId(theme.id);
                setSidebarOpen(false);
              }}
            >
              <GitBranch size={16} />
              <span>{theme.title}</span>
              <ChevronRight size={15} />
            </button>
          ))}
        </section>
        <section className="sidebar-section sidebar-section--chapters">
          <h3>原文章节</h3>
          {payload.chapters.map((chapter) => {
            const sourceNode = nodes.find((node) =>
              node.sources.some((source) => source.chapter_id === chapter.id),
            );
            return (
              <button
                key={chapter.id}
                disabled={!sourceNode}
                onClick={() => {
                  setFocusId(sourceNode?.id ?? focus.id);
                  setSelectedId(sourceNode?.id ?? currentNode.id);
                }}
              >
                <span>第 {chapter.ordinal} 章</span>
                <strong>{chapter.title}</strong>
              </button>
            );
          })}
        </section>
      </aside>

      <main className="map-main">
        <div className="workspace-topbar">
          <button
            className="icon-button workspace-menu-button"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-label="打开书籍结构"
          >
            <Menu size={19} />
          </button>
          <nav className="breadcrumbs" aria-label="阅读路径">
            {focusPath.map((node, index) => (
              <span key={node.id}>
                {index ? <ChevronRight size={14} /> : null}
                <button
                  onClick={() => {
                    setFocusId(node.id);
                    setSelectedId(node.id);
                  }}
                >
                  {node.title}
                </button>
              </span>
            ))}
          </nav>
          <div className="workspace-tabs">
            <Link className="is-active" to={`/books/${bookId}/map`}>
              逻辑地图
            </Link>
            <Link
              to={
                currentNode.sources[0]
                  ? `/books/${bookId}/read/${currentNode.sources[0].paragraph_id}?fromNode=${currentNode.id}`
                  : "#"
              }
            >
              原文阅读
            </Link>
          </div>
          <button className="icon-button" aria-label="地图设置">
            <Menu size={19} />
          </button>
        </div>

        <section className="map-canvas">
          <div className="map-toolbar">
            <span className="map-toolbar__title">全书逻辑地图</span>
            <span className="map-toolbar__hint">已展开全部层级，可缩放、拖动画布查看</span>
            <div className="map-toolbar__actions">
              <button
                className="button button--secondary button--small"
                disabled={!activeNode?.chapter_id || splitChapterMutation.isPending || ["queued", "running"].includes(splitJobQuery.data?.status ?? "")}
                onClick={() => activeNode?.chapter_id && splitChapterMutation.mutate(activeNode.chapter_id)}
              >
                <RefreshCw size={15} className={splitChapterMutation.isPending ? "spin" : undefined} />
                {splitChapterMutation.isPending || ["queued", "running"].includes(splitJobQuery.data?.status ?? "")
                  ? "正在创建任务…"
                  : activeNode?.type === "unit"
                    ? "重新拆分本章"
                    : "拆分本章"}
              </button>
              <label className="switch-control">
                <input
                  type="checkbox"
                  checked={showRelations}
                  onChange={(event) => setShowRelations(event.target.checked)}
                />
                <span />
                显示逻辑关系
              </label>
              <button className="icon-button" aria-label="定位当前节点">
                <LocateFixed size={18} />
              </button>
              <button className="icon-button" aria-label="全屏查看">
                <Maximize2 size={18} />
              </button>
            </div>
          </div>
          <ReactFlow
            key={`${payload.map_version.id}-${showRelations}`}
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => {
              setSelectedId(node.id);
            }}
            onPaneClick={() => undefined}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.05 }}
            minZoom={0.55}
            maxZoom={1.4}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#d9ddd6" gap={24} size={1} />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
          <div className="mobile-map-list" aria-label="当前层级观点列表">
            {mobileGraph.map((node) => {
              return (
                <button
                  key={node.id}
                  className={node.id === currentNode.id ? "is-selected" : ""}
                  onClick={() => {
                    setSelectedId(node.id);
                  }}
                >
                  <small>
                    {nodeTypeLabel(node.type)}
                    {node.origin === "inferred" ? " · AI 推断" : ""}
                  </small>
                  <strong>{node.title}</strong>
                  <p>{excerpt(node.statement, 94)}</p>
                </button>
              );
            })}
          </div>
          <div className="map-legend">
            <span>
              <i className="line line--solid" />
              层级结构
            </span>
            <span>
              <i className="line line--dashed" />
              AI 推断
            </span>
            <span>
              <i className="line line--author" />
              作者关系
            </span>
          </div>
        </section>
      </main>

      <aside className="detail-panel">
        <header className="detail-panel__header">
          <span className="eyebrow">
            {currentNode.child_count ? "观点概览" : "原文依据"}
          </span>
          <h2>{currentNode.title}</h2>
          <p>{currentNode.statement}</p>
          {currentNode.origin === "inferred" ? (
            <span className="origin-badge">AI 推断，可查看依据</span>
          ) : (
            <span className="origin-badge origin-badge--author">作者明确表达</span>
          )}
        </header>

        {currentNode.summary ? (
          <section className="detail-section">
            <h3>解释</h3>
            <p>{currentNode.summary}</p>
          </section>
        ) : null}

        {currentNode.conditions.length ? (
          <section className="detail-section detail-section--condition">
            <h3>适用条件</h3>
            <ul>
              {currentNode.conditions.map((condition) => (
                <li key={condition}>{condition}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {currentNode.sources.length ? (
          <section className="detail-section">
            <h3>原文出处</h3>
            <div className="source-list">
              {currentNode.sources.map((source) => (
                <button
                  key={source.id}
                  onClick={() =>
                    navigate(
                      `/books/${bookId}/read/${source.paragraph_id}?fromNode=${currentNode.id}`,
                    )
                  }
                >
                  <span>
                    <FileText size={16} />
                    第 {source.chapter_title} · 第 {source.paragraph_ordinal} 段
                  </span>
                  <small>{excerpt(source.quote, 58)}</small>
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {related.length ? (
          <section className="detail-section">
            <h3>相关观点</h3>
            <div className="related-list">
              {related.map(({ relation, node }) => (
                <button
                  key={relation.id}
                  onClick={() => {
                    setSelectedId(node!.id);
                    setFocusId(node!.id);
                  }}
                >
                  <span className={relation.origin === "inferred" ? "dashed-dot" : "solid-dot"} />
                  <span>
                    <strong>{node!.title}</strong>
                    <small>
                      {relationLabel(relation.type)} ·{" "}
                      {relation.origin === "inferred" ? "AI 推断" : "作者关系"}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className="detail-panel__actions">
          {currentNode.sources.length ? (
            <button
              className="button button--primary"
              onClick={() =>
                navigate(
                  `/books/${bookId}/read/${currentNode.sources[0].paragraph_id}?fromNode=${currentNode.id}`,
                )
              }
            >
              <BookOpen size={17} />
              阅读这一段
            </button>
          ) : null}
        </div>
        <footer className="detail-panel__footer">
          <span>已探索 {payload.book.explored_count} 个观点</span>
          <span>已标记读完 {payload.book.read_count} 段</span>
        </footer>
      </aside>
      {sidebarOpen ? (
        <button
          className="mobile-scrim"
          aria-label="关闭导航"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
    </div>
  );
}
