export type BookStatus =
  | "awaiting_structure_confirmation"
  | "structure_confirmed"
  | "generating"
  | "partial_ready"
  | "ready"
  | "failed_partial"
  | "failed"
  | "deleting";

export interface Job {
  id: string;
  book_id: string;
  version_id: string;
  map_version_id: string | null;
  kind: string;
  status: "queued" | "running" | "completed" | "failed" | "partial";
  stage: string;
  progress: number;
  completed_units: number;
  total_units: number;
  message: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Book {
  id: string;
  owner_id: string;
  title: string;
  author: string;
  subtitle: string;
  description: string;
  cover_tone: string;
  cover_url?: string | null;
  status: BookStatus;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  last_read_at: string | null;
  reading_position?: ReadingPosition | null;
  chapter_count: number;
  paragraph_count: number;
  explored_count: number;
  read_count: number;
  format: string | null;
  job?: Job | null;
}

export type ReadingPositionInput = {
  chapter_id: string;
  reading_unit_id: string | null;
  paragraph_id: string | null;
  character_offset: number;
  section_ordinal: number | null;
  anchor_progress: number;
  captured_at: number;
};
export type ReadingPosition = ReadingPositionInput & { chapter_title: string; unit_title: string | null; resume_path: string; updated_at: string };
export type ReadingPositionPayload = { position: ReadingPosition | null; resume_path?: string | null };

export interface Chapter {
  id: string;
  version_id: string;
  parent_id: string | null;
  ordinal: number;
  title: string;
  source_path: string | null;
  page_start: number | null;
  page_end: number | null;
  paragraph_count?: number;
}

export type ChapterWorkStatus = "unprocessed" | "splitting" | "ready" | "failed";

export interface WorkbenchChapter extends Chapter {
  units: ReadingUnit[];
  status: ChapterWorkStatus;
  unit_count: number;
  job: Job | null;
  unit_set?: UnitSet | null;
}

export interface UnitSet {
  id: string;
  chapter_id: string;
  source_hash: string;
  planner_route: string;
  status: string;
  intro: string;
  created_at: string;
  published_at: string | null;
}

export interface ReadingUnit {
  id: string;
  unit_set_id: string;
  chapter_id: string;
  ordinal: number;
  title: string;
  statement: string;
  summary: string;
  review_status: string;
  status: string;
  created_at: string;
  paragraph_count?: number;
}

export interface ReadingUnitSection {
  id: string;
  reading_unit_id: string;
  ordinal: number;
  kind: string;
  title: string;
  body: string;
}

export interface ChapterListPayload {
  book: Book;
  chapters: WorkbenchChapter[];
}

export interface ChapterDetailPayload {
  history: Array<UnitSet & { units: ReadingUnit[] }>;
  book: Book;
  chapter: WorkbenchChapter;
  paragraphs: Paragraph[];
  annotations: Annotation[];
  units: ReadingUnit[];
}

export interface ReadingUnitPayload {
  book: Book;
  chapter: {
    id: string;
    title: string;
    unit_set: UnitSet | null;
    units: ReadingUnit[];
  };
  unit: ReadingUnit & { chapter_title: string; book_id: string };
  paragraphs: Paragraph[];
  sections: ReadingUnitSection[];
  annotations: Annotation[];
}

export interface Source {
  id: string;
  node_id: string;
  paragraph_id: string;
  start_offset: number;
  end_offset: number | null;
  quote: string;
  chapter_id: string;
  paragraph_ordinal: number;
  chapter_title: string;
}

export interface MapNode {
  id: string;
  map_version_id: string;
  parent_id: string | null;
  type: "question" | "theme" | "unit" | "claim" | "evidence" | "example" | "condition";
  title: string;
  statement: string;
  summary: string;
  conditions: string[];
  origin: "author" | "inferred";
  confidence: number;
  ordinal: number;
  status: string;
  sources: Source[];
  child_count: number;
  reading_unit_id: string | null;
  chapter_id: string | null;
}

export interface MapRelation {
  id: string;
  map_version_id: string;
  from_node_id: string;
  to_node_id: string;
  type: "supports" | "refutes" | "premise" | "causes" | "explains" | "qualifies" | "next";
  origin: "author" | "inferred";
  evidence: string;
  confidence: number;
  status: string;
}

export interface ReadingState {
  user_id: string;
  book_id: string;
  last_map_version_id: string | null;
  last_node_id: string | null;
  last_paragraph_id: string | null;
  path: string[];
  updated_at?: string;
}

export interface MapPayload {
  book: Book;
  map_version: {
    id: string;
    book_version_id: string;
    status: string;
    prompt_version: string;
    model_route: string;
    created_at: string;
    published_at: string;
  };
  nodes: MapNode[];
  relations: MapRelation[];
  chapters: Chapter[];
  state: ReadingState | null;
}

export interface StructurePayload {
  book: Book;
  chapters: Chapter[];
}

export interface Paragraph {
  id: string;
  chapter_id: string;
  ordinal: number;
  text: string;
  normalized_text: string;
  anchor_json: string;
  text_hash: string;
  status: string;
  chapter_title?: string;
  chapter_ordinal?: number;
  version_id?: string;
}

export interface Note {
  id: string;
  user_id: string;
  version_id: string;
  paragraph_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  paragraph_text?: string;
  paragraph_ordinal?: number;
  chapter_title?: string;
  book_title?: string;
  book_id?: string;
}

export type ReadingNoteKind = "section" | "annotation" | "paragraph_note";

export interface ReadingNote {
  kind: ReadingNoteKind;
  id: string;
  body: string;
  created_at: string | null;
  updated_at: string | null;
  book_id: string;
  book_title: string;
  chapter_id: string;
  chapter_title: string;
  chapter_ordinal: number;
  reading_unit_id: string | null;
  reading_unit_title: string | null;
  unit_ordinal: number | null;
  section_ordinal: number | null;
  section_title: string | null;
  section_kind: string | null;
  paragraph_id: string | null;
  paragraph_ordinal: number | null;
  paragraph_text: string | null;
  quote: string | null;
  is_current_version: boolean;
  link_path: string;
}

export interface ReadingNoteListPayload {
  items: ReadingNote[];
  counts: {
    total: number;
    section: number;
    annotation: number;
    paragraph_note: number;
  };
}

export interface Annotation {
  id: string;
  user_id: string;
  version_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  anchors: Array<{
    id: string;
    annotation_id: string;
    paragraph_id: string;
    start_offset: number;
    end_offset: number;
    quote: string;
  }>;
}

export interface ReaderPayload {
  book: Book;
  paragraph: Paragraph & { chapter_title: string; chapter_ordinal: number };
  context: Paragraph[];
  related_nodes: MapNode[];
  notes: Note[];
  annotations: Annotation[];
  read: boolean;
  state: ReadingState | null;
  chapters: Chapter[];
}

export interface SearchPayload {
  query: string;
  paragraphs: Array<{
    id: string;
    text: string;
    ordinal: number;
    chapter_id: string;
    chapter_title: string;
    chapter_ordinal: number;
  }>;
  nodes: Array<{
    id: string;
    title: string;
    statement: string;
    type: string;
    origin: string;
  }>;
  total: number;
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: Record<string, unknown>;
  };
}

export interface ModelConfiguration {
  provider: "local" | "openai" | "anthropic";
  base_url: string;
  model: string;
  timeout: number;
  has_api_key: boolean;
}
