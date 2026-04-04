/** @format */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Flex,
  Input,
  Layout,
  List,
  message,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Skeleton,
  Space,
  Spin,
  Switch,
  Tooltip,
  Typography,
} from "antd";
import {
  ArrowUpOutlined,
  DeleteOutlined,
  ExportOutlined,
  PlusOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  HolderOutlined,
  LoadingOutlined,
  SearchOutlined,
  SyncOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { HighlightTextarea } from "./components/HighlightTextarea";
import "./App.css";

const { Sider, Content } = Layout;
const { Text, Title } = Typography;

type DocSummary = {
  id: number;
  filename: string;
  uploaded_at: string;
  total_pages: number;
  highlight_count: number;
  /** False for documents uploaded before originals were persisted */
  original_stored?: boolean;
};

type Highlight = {
  id: number;
  text: string;
  is_very_important: boolean;
};

type SlideRow = {
  slide_id: number;
  page_number: number;
  image_url: string;
  has_highlights: boolean;
  is_hidden: boolean;
  /** Full page text for search (not shown in UI). */
  full_text: string;
  highlights: Highlight[];
};

type UploadResult = {
  document_id: number;
  filename: string;
  total_pages: number;
  highlights_found: number;
};

type UploadResponse = {
  results: UploadResult[];
  warnings: { document_id?: number; filename: string; message: string }[];
};

type ImportJobRef = { job_id: number; filename: string };

type UploadQueuedResponse = {
  jobs: ImportJobRef[];
  warnings: UploadResponse["warnings"];
};

type ImportJobPoll = {
  job_id: number;
  filename: string;
  status: string;
  document_id: number | null;
  error_message: string | null;
  result: UploadResult | null;
  warnings: UploadResponse["warnings"];
  progress_current?: number | null;
  progress_total?: number | null;
  progress_label?: string | null;
  progress_percent?: number | null;
};

type ActiveImportJobRow = {
  filename: string;
  status: string;
  /** Set once ingest creates the documents row; sidebar hides duplicate until job completes. */
  document_id?: number | null;
  progress_current?: number | null;
  progress_total?: number | null;
  progress_label?: string | null;
  progress_percent?: number | null;
};

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || res.statusText);
  }
  return res.json() as Promise<T>;
}

async function pollImportJob(
  jobId: number,
  intervalMs = 900,
  onUpdate?: (j: ImportJobPoll) => void,
): Promise<ImportJobPoll> {
  for (;;) {
    const j = await apiJson<ImportJobPoll>(`/import/jobs/${jobId}`);
    onUpdate?.(j);
    if (j.status === "completed" || j.status === "failed") {
      return j;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function filterSlides(
  slides: SlideRow[],
  hideNoHighlights: boolean,
  starredOnly: boolean,
): SlideRow[] {
  return slides.filter((s) => {
    if (hideNoHighlights && !s.has_highlights) return false;
    if (starredOnly) {
      const anyStarred = s.highlights.some((h) => h.is_very_important);
      if (!anyStarred) return false;
    }
    return true;
  });
}

function SortableDocRow({
  doc,
  selected,
  exportChecked,
  onSelect,
  onDelete,
  onExportCheckChange,
  deleting,
  disableDrag,
  hiddenDuringImport,
}: {
  doc: DocSummary;
  selected: boolean;
  exportChecked: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onExportCheckChange: (checked: boolean) => void;
  deleting: boolean;
  disableDrag: boolean;
  /** Hide row while same PDF is shown in the import progress block (keep in DOM for reorder). */
  hiddenDuringImport: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: doc.id,
    disabled: disableDrag || deleting || hiddenDuringImport,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ?
      { opacity: 0.85, zIndex: 2, position: "relative" as const }
    : {}),
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`doc-list-row${selected ? " doc-list-row--selected" : ""}${
        exportChecked ? " doc-list-row--export-checked" : ""
      }${deleting ? " doc-list-row--busy" : ""}${
        hiddenDuringImport ? " doc-list-row--hidden-import" : ""
      }`}
      aria-busy={deleting}
      aria-hidden={hiddenDuringImport}
    >
      <button
        type="button"
        className="doc-list-drag"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
      >
        <HolderOutlined />
      </button>
      <div
        className="doc-list-row-body"
        role="button"
        tabIndex={deleting ? -1 : 0}
        onClick={deleting ? undefined : onSelect}
        onKeyDown={(e) => {
          if (deleting) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        <Text ellipsis className="doc-list-row-title" style={{ maxWidth: 180 }}>
          {doc.filename}
        </Text>
        <Text type="secondary" className="doc-list-slide-count">
          {doc.total_pages} {doc.total_pages === 1 ? "slide" : "slides"}
        </Text>
      </div>
      <Popconfirm
        title="Delete this PDF?"
        description="Slides and highlights will be removed."
        okText="Delete"
        okButtonProps={{ danger: true }}
        disabled={deleting}
        onConfirm={onDelete}
        onCancel={(e) => e?.stopPropagation()}
      >
        <Button
          type="text"
          danger
          size="small"
          loading={deleting}
          icon={deleting ? undefined : <DeleteOutlined />}
          aria-label="Delete document"
          onClick={(e) => e.stopPropagation()}
        />
      </Popconfirm>
      <div
        className="doc-export-checkbox-wrap"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={exportChecked}
          disabled={deleting}
          aria-label={`Include ${doc.filename} in export`}
          onChange={(e) => onExportCheckChange(e.target.checked)}
        />
      </div>
    </div>
  );
}

export default function App() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [slides, setSlides] = useState<SlideRow[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [loadingSlides, setLoadingSlides] = useState(false);
  /** True only while the multipart POST to /upload is in flight (before response). */
  const [uploading, setUploading] = useState(false);
  /** Per-job UI while background import runs (progress from GET /import/jobs/:id). */
  const [importJobUi, setImportJobUi] = useState<
    Record<number, ActiveImportJobRow>
  >({});
  const [hideNoHl, setHideNoHl] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
  const [slideSearch, setSlideSearch] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [docTitleEditing, setDocTitleEditing] = useState(false);
  const [docTitleDraft, setDocTitleDraft] = useState("");
  const [exportCheckedIds, setExportCheckedIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [focusNewNoteHighlightId, setFocusNewNoteHighlightId] = useState<
    number | null
  >(null);
  const [deletingDocId, setDeletingDocId] = useState<number | null>(null);
  const [reorderingDocuments, setReorderingDocuments] = useState(false);
  const [savingDocTitle, setSavingDocTitle] = useState(false);
  const [pendingStarIds, setPendingStarIds] = useState(() => new Set<number>());
  const [pendingDeleteIds, setPendingDeleteIds] = useState(
    () => new Set<number>(),
  );
  const [pendingHideSlideIds, setPendingHideSlideIds] = useState(
    () => new Set<number>(),
  );
  const [pendingAddNoteSlideIds, setPendingAddNoteSlideIds] = useState(
    () => new Set<number>(),
  );
  const [exporting, setExporting] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const mainSlidesRef = useRef<HTMLDivElement>(null);
  const firstSlideRef = useRef<HTMLDivElement | null>(null);
  const [showScrollTopFab, setShowScrollTopFab] = useState(false);
  /** Prevents duplicate poll loops (e.g. React Strict Mode or recover + upload). */
  const pollingImportJobIdsRef = useRef<Set<number>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const loadDocuments = useCallback(async () => {
    setLoadingDocs(true);
    try {
      const rows = await apiJson<DocSummary[]>("/documents");
      setDocs(rows);
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  const mergeImportPoll = useCallback((polled: ImportJobPoll) => {
    setImportJobUi((prev) => ({
      ...prev,
      [polled.job_id]: {
        filename: polled.filename,
        status: polled.status,
        document_id: polled.document_id,
        progress_current: polled.progress_current,
        progress_total: polled.progress_total,
        progress_label: polled.progress_label,
        progress_percent: polled.progress_percent,
      },
    }));
  }, []);

  /** Sidebar doc row hidden while a matching import job is active (doc exists in DB before ingest finishes). */
  const hiddenImportDocIds = useMemo(() => {
    const s = new Set<number>();
    for (const r of Object.values(importJobUi)) {
      if (r.document_id != null) {
        s.add(r.document_id);
      } else {
        const match = docs.find((d) => d.filename === r.filename);
        if (match) s.add(match.id);
      }
    }
    return s;
  }, [importJobUi, docs]);

  useEffect(() => {
    if (selectedId != null && hiddenImportDocIds.has(selectedId)) {
      setSelectedId(null);
      setSlides([]);
    }
  }, [selectedId, hiddenImportDocIds]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    message.info(
      "Be patient, this app runs on free services and may feel slow",
      8,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiJson<{ jobs: ImportJobPoll[] }>(
          "/import/jobs/active",
        );
        if (cancelled || !data.jobs?.length) return;
        setImportJobUi((prev) => {
          const next = { ...prev };
          for (const j of data.jobs) {
            next[j.job_id] = {
              filename: j.filename,
              status: j.status,
              document_id: j.document_id,
              progress_current: j.progress_current,
              progress_total: j.progress_total,
              progress_label: j.progress_label,
              progress_percent: j.progress_percent,
            };
          }
          return next;
        });
        for (const j of data.jobs) {
          if (pollingImportJobIdsRef.current.has(j.job_id)) continue;
          pollingImportJobIdsRef.current.add(j.job_id);
          void (async () => {
            const jobId = j.job_id;
            try {
              const final = await pollImportJob(jobId, 900, mergeImportPoll);
              if (cancelled) return;
              if (final.status === "failed") {
                message.error(
                  `${final.filename}: ${final.error_message ?? "Import failed"}`,
                  10,
                );
              } else {
                for (const w of final.warnings ?? []) {
                  message.warning(`${w.filename}: ${w.message}`, 8);
                }
                if (final.result?.document_id != null) {
                  setSelectedId((prev) => prev ?? final.result!.document_id);
                }
              }
              await loadDocuments();
            } catch (e) {
              if (!cancelled) message.error(String(e));
            } finally {
              pollingImportJobIdsRef.current.delete(jobId);
              if (!cancelled) {
                setImportJobUi((prev) => {
                  const n = { ...prev };
                  delete n[jobId];
                  return n;
                });
              }
            }
          })();
        }
      } catch {
        /* Older API or offline */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDocuments, mergeImportPoll]);

  useEffect(() => {
    const valid = new Set(docs.map((d) => d.id));
    setExportCheckedIds((prev) => {
      const next = new Set<number>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
      }
      return next;
    });
  }, [docs]);

  const loadSlides = useCallback(async (docId: number) => {
    setLoadingSlides(true);
    try {
      const rows = await apiJson<SlideRow[]>(`/documents/${docId}/slides`);
      setSlides(rows);
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoadingSlides(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId != null) {
      void loadSlides(selectedId);
      const id = requestAnimationFrame(() => {
        mainSlidesRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      });
      return () => cancelAnimationFrame(id);
    }
    setSlides([]);
    return undefined;
  }, [selectedId, loadSlides]);

  useEffect(() => {
    setDocTitleEditing(false);
    setSavingDocTitle(false);
    setSlideSearch("");
  }, [selectedId]);

  const visible = useMemo(() => {
    let list = filterSlides(slides, hideNoHl, starredOnly);
    const q = slideSearch.trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        (s.full_text ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [slides, hideNoHl, starredOnly, slideSearch]);

  const firstVisibleSlideId = visible[0]?.slide_id;

  useEffect(() => {
    const root = mainSlidesRef.current;
    const target = firstSlideRef.current;
    if (!root || !target || visible.length === 0) {
      setShowScrollTopFab(false);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        setShowScrollTopFab(!entry.isIntersecting);
      },
      { root, threshold: 0 },
    );
    obs.observe(target);
    return () => {
      obs.disconnect();
    };
  }, [visible.length, firstVisibleSlideId, loadingSlides, selectedId]);

  const scrollSlidesToTop = useCallback(() => {
    mainSlidesRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  /** Oldest job at top of footer, newest at bottom (job_id order). */
  const importJobEntriesSorted = useMemo(
    () =>
      Object.entries(importJobUi).sort(
        (a, b) => Number(a[0]) - Number(b[0]),
      ),
    [importJobUi],
  );

  const processingUpload = uploading;
  const processingRescan = rescanning;
  const processingBusy = processingUpload || processingRescan || exporting;

  const onUploadPick = () => fileRef.current?.click();

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    e.target.value = "";
    if (!list?.length) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (let i = 0; i < list.length; i++) {
        form.append("files", list[i]!);
      }
      const res = await fetch("/upload", { method: "POST", body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as UploadQueuedResponse | UploadResponse;
      const warnings = data.warnings ?? [];
      for (const w of warnings) {
        message.warning(`${w.filename}: ${w.message}`, 8);
      }

      // Jobs are queued on the server; allow another import while this batch finishes.
      setUploading(false);

      if (res.status === 202 && "jobs" in data && data.jobs.length) {
        const batch = data.jobs;
        setImportJobUi((prev) => {
          const next = { ...prev };
          for (const j of batch) {
            next[j.job_id] = {
              filename: j.filename,
              status: "pending",
              progress_label: "Queued…",
            };
          }
          return next;
        });
        for (const j of batch) {
          pollingImportJobIdsRef.current.add(j.job_id);
        }
        try {
          const outcomes = await Promise.all(
            batch.map((j) =>
              pollImportJob(j.job_id, 900, mergeImportPoll),
            ),
          );
          let lastDocId: number | undefined;
          let failCount = 0;
          for (const o of outcomes) {
            if (o.status === "failed") {
              failCount += 1;
              message.error(
                `${o.filename}: ${o.error_message ?? "Import failed"}`,
                10,
              );
            } else {
              for (const w of o.warnings) {
                message.warning(`${w.filename}: ${w.message}`, 8);
              }
              if (o.result?.document_id != null) {
                lastDocId = o.result.document_id;
              }
            }
          }
          if (lastDocId != null) setSelectedId(lastDocId);
          await loadDocuments();
          if (failCount === 0) message.success("Upload complete");
          else if (failCount < outcomes.length)
            message.warning("Some uploads failed");
        } catch (pollErr) {
          message.error(String(pollErr));
        } finally {
          for (const j of batch) {
            pollingImportJobIdsRef.current.delete(j.job_id);
          }
          setImportJobUi((prev) => {
            const next = { ...prev };
            for (const j of batch) {
              delete next[j.job_id];
            }
            return next;
          });
        }
      } else {
        const sync = data as UploadResponse;
        if (sync.results.length) {
          const last = sync.results[sync.results.length - 1]!;
          setSelectedId(last.document_id);
        }
        await loadDocuments();
        if (sync.results.length) message.success("Upload complete");
      }
    } catch (err) {
      message.error(String(err));
    } finally {
      setUploading(false);
    }
  };

  const exportSelected = async () => {
    const ids = Array.from(exportCheckedIds);
    if (ids.length === 0) return;
    setExporting(true);
    try {
      const params = new URLSearchParams();
      for (const id of ids) params.append("document_ids", String(id));
      const res = await fetch(`/export?${params.toString()}`);
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "study_master.txt";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      message.error(String(e));
    } finally {
      setExporting(false);
    }
  };

  const setExportChecked = useCallback((docId: number, checked: boolean) => {
    setExportCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(docId);
      else next.delete(docId);
      return next;
    });
  }, []);

  const patchHide = async (slideId: number, hidden: boolean) => {
    setPendingHideSlideIds((prev) => new Set(prev).add(slideId));
    try {
      await apiJson(`/slides/${slideId}/hide`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden }),
      });
      setSlides((prev) =>
        prev.map((s) =>
          s.slide_id === slideId ? { ...s, is_hidden: hidden } : s,
        ),
      );
    } catch (e) {
      message.error(String(e));
    } finally {
      setPendingHideSlideIds((prev) => {
        const next = new Set(prev);
        next.delete(slideId);
        return next;
      });
    }
  };

  const patchStarred = async (highlightId: number, starred: boolean) => {
    setPendingStarIds((prev) => new Set(prev).add(highlightId));
    try {
      await apiJson(`/highlights/${highlightId}/very-important`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ very_important: starred }),
      });
      setSlides((prev) =>
        prev.map((s) => ({
          ...s,
          highlights: s.highlights.map((h) =>
            h.id === highlightId ?
              { ...h, is_very_important: starred }
            : h,
          ),
        })),
      );
    } catch (e) {
      message.error(String(e));
    } finally {
      setPendingStarIds((prev) => {
        const next = new Set(prev);
        next.delete(highlightId);
        return next;
      });
    }
  };

  const selectedDoc = useMemo(
    () => docs.find((d) => d.id === selectedId) ?? null,
    [docs, selectedId],
  );

  const saveDocumentTitle = async (name: string) => {
    const trimmed = name.trim();
    if (selectedId == null || !selectedDoc) {
      setDocTitleEditing(false);
      return;
    }
    if (!trimmed) {
      message.error("Title cannot be empty");
      setDocTitleDraft(selectedDoc.filename);
      setDocTitleEditing(false);
      return;
    }
    if (trimmed === selectedDoc.filename) {
      setDocTitleEditing(false);
      return;
    }
    setSavingDocTitle(true);
    try {
      await apiJson<{ id: number; filename: string }>(
        `/documents/${selectedId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: trimmed }),
        },
      );
      setDocs((prev) =>
        prev.map((d) =>
          d.id === selectedId ? { ...d, filename: trimmed } : d,
        ),
      );
      message.success("Title updated");
    } catch (e) {
      message.error(String(e));
    } finally {
      setSavingDocTitle(false);
      setDocTitleEditing(false);
    }
  };

  const onDocumentsDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = docs.findIndex((d) => d.id === active.id);
    const newIndex = docs.findIndex((d) => d.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(docs, oldIndex, newIndex);
    setDocs(next);
    setReorderingDocuments(true);
    try {
      await apiJson("/documents/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: next.map((d) => d.id) }),
      });
    } catch (e) {
      message.error(String(e));
      void loadDocuments();
    } finally {
      setReorderingDocuments(false);
    }
  };

  const deleteDocument = async (docId: number) => {
    setDeletingDocId(docId);
    try {
      await apiJson(`/documents/${docId}`, { method: "DELETE" });
      setExportCheckedIds((prev) => {
        const next = new Set(prev);
        next.delete(docId);
        return next;
      });
      if (selectedId === docId) {
        setSelectedId(null);
        setSlides([]);
      }
      await loadDocuments();
      message.success("Document removed");
    } catch (e) {
      message.error(String(e));
    } finally {
      setDeletingDocId(null);
    }
  };

  const rescanDocument = async () => {
    if (selectedId == null) return;
    setRescanning(true);
    try {
      const data = await apiJson<{
        document_id: number;
        highlights_found: number;
        warnings: { message: string }[];
      }>(`/documents/${selectedId}/rescan`, { method: "POST" });
      for (const w of data.warnings) {
        message.warning(w.message, 8);
      }
      message.success(
        `Rescan complete: ${data.highlights_found} highlight(s) found`,
      );
      await loadDocuments();
      await loadSlides(selectedId);
    } catch (e) {
      message.error(String(e));
    } finally {
      setRescanning(false);
    }
  };

  const removeHighlight = async (highlightId: number) => {
    setPendingDeleteIds((prev) => new Set(prev).add(highlightId));
    try {
      await apiJson(`/highlights/${highlightId}`, { method: "DELETE" });
      setSlides((prev) =>
        prev.map((s) => {
          const nextHl = s.highlights.filter((h) => h.id !== highlightId);
          const hasHl = nextHl.length > 0;
          return {
            ...s,
            highlights: nextHl,
            has_highlights: hasHl,
          };
        }),
      );
      await loadDocuments();
    } catch (e) {
      message.error(String(e));
    } finally {
      setPendingDeleteIds((prev) => {
        const next = new Set(prev);
        next.delete(highlightId);
        return next;
      });
    }
  };

  const saveHighlightText = async (highlightId: number, text: string) => {
    await apiJson<{ highlight_id: number; text: string }>(
      `/highlights/${highlightId}/text`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
    );
    setSlides((prev) =>
      prev.map((s) => ({
        ...s,
        highlights: s.highlights.map((h) =>
          h.id === highlightId ? { ...h, text } : h,
        ),
      })),
    );
  };

  const clearNewNoteFocus = useCallback(() => {
    setFocusNewNoteHighlightId(null);
  }, []);

  const addHighlightNote = async (slideId: number) => {
    if (selectedId == null) return;
    setPendingAddNoteSlideIds((prev) => new Set(prev).add(slideId));
    try {
      const data = await apiJson<{ highlight_id: number }>(
        `/slides/${slideId}/highlights`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "<p></p>" }),
        },
      );
      await loadSlides(selectedId);
      setFocusNewNoteHighlightId(data.highlight_id);
      await loadDocuments();
    } catch (e) {
      message.error(String(e));
    } finally {
      setPendingAddNoteSlideIds((prev) => {
        const next = new Set(prev);
        next.delete(slideId);
        return next;
      });
    }
  };

  return (
    <>
      <Layout className="app-shell">
        <Layout className="app-body">
          <Sider
            className="app-sider"
            width={280}
            theme="light"
            style={{
              borderRight: "1px solid #d1d7e0",
              background: "#e4e7ef",
            }}
          >
            <div className="app-sider-header">
              <div className="app-sider-header-inner">
                <Title
                  level={5}
                  className="app-sider-brand"
                  style={{ margin: "0 0 12px" }}
                >
                  Bella Note
                </Title>
                <Flex gap={8} className="app-sider-toolbar" align="center">
                  <Tooltip title="Import new PDFs">
                    <Button
                      type="primary"
                      className="app-sider-tool-import"
                      icon={<UploadOutlined />}
                      loading={uploading}
                      disabled={processingRescan || exporting}
                      onClick={onUploadPick}
                    >
                      Import New
                    </Button>
                  </Tooltip>
                  <Tooltip title="Export selected">
                    <Button
                      className="app-sider-tool-export"
                      icon={<ExportOutlined />}
                      loading={exporting}
                      disabled={
                        uploading ||
                        rescanning ||
                        exportCheckedIds.size === 0 ||
                        exporting
                      }
                      onClick={() => void exportSelected()}
                      aria-label="Export selected"
                    />
                  </Tooltip>
                </Flex>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  hidden
                  disabled={uploading || processingRescan || exporting}
                  onChange={(e) => void onFiles(e)}
                />
              </div>
              <div className="app-sider-divider" role="separator" />
            </div>
            <div className="app-sider-middle">
              <div className="app-sider-doc-scroll">
                {reorderingDocuments ?
                  <div
                    className="doc-list-reorder-status"
                    role="status"
                    aria-live="polite"
                  >
                    <LoadingOutlined spin aria-hidden />
                    <Text type="secondary">Saving order…</Text>
                  </div>
                : null}
                {loadingDocs && docs.length === 0 ?
                  <div
                    className="doc-list-placeholder-row"
                    aria-busy="true"
                    aria-live="polite"
                  >
                    <span className="doc-list-placeholder-drag" aria-hidden />
                    <div className="doc-list-placeholder-body">
                      <LoadingOutlined
                        className="doc-list-placeholder-icon"
                        spin
                        aria-hidden
                      />
                      <Text type="secondary">Loading documents…</Text>
                    </div>
                  </div>
                : null}
                {docs.length === 0 &&
                !uploading &&
                !loadingDocs &&
                Object.keys(importJobUi).length === 0 ?
                  <div className="doc-list-empty">No PDFs yet</div>
                : docs.length > 0 ?
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={(e) => void onDocumentsDragEnd(e)}
                  >
                    <SortableContext
                      items={docs.map((d) => d.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="doc-sortable-list">
                        {docs.map((d) => (
                          <SortableDocRow
                            key={d.id}
                            doc={d}
                            selected={selectedId === d.id}
                            exportChecked={exportCheckedIds.has(d.id)}
                            onSelect={() => setSelectedId(d.id)}
                            onDelete={() => void deleteDocument(d.id)}
                            onExportCheckChange={(checked) =>
                              setExportChecked(d.id, checked)
                            }
                            deleting={deletingDocId === d.id}
                            disableDrag={reorderingDocuments}
                            hiddenDuringImport={hiddenImportDocIds.has(d.id)}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                : null}
              </div>
            </div>
            {importJobEntriesSorted.length > 0 ?
              <div
                className="app-sider-import-footer"
                aria-label="Imports in progress"
              >
                {importJobEntriesSorted.map(([idStr, row]) => {
                  const jobId = Number(idStr);
                  const pct =
                    row.progress_percent != null &&
                    Number.isFinite(row.progress_percent) ?
                      Math.round(row.progress_percent)
                    : undefined;
                  const cur = row.progress_current;
                  const tot = row.progress_total;
                  const hasRatio =
                    cur != null && tot != null && tot > 0;
                  const remaining =
                    hasRatio && cur != null && tot != null ?
                      Math.max(0, tot - cur)
                    : null;
                  return (
                    <div
                      key={jobId}
                      className="doc-list-import-row"
                      role="status"
                      aria-live="polite"
                      aria-busy={
                        row.status !== "completed" &&
                        row.status !== "failed"
                      }
                    >
                      <div className="doc-list-import-body">
                        <Text
                          ellipsis
                          className="doc-list-import-filename"
                          title={row.filename}
                        >
                          {row.filename}
                        </Text>
                        {pct != null ?
                          <Progress percent={pct} size="small" />
                        : <Progress
                            percent={0}
                            status="active"
                            size="small"
                            showInfo={false}
                          />
                        }
                        <div className="doc-list-import-meta">
                          <Text
                            type="secondary"
                            className="doc-list-import-label"
                          >
                            {row.progress_label ?? "Working…"}
                          </Text>
                          {hasRatio && cur != null && tot != null ?
                            <Text
                              type="secondary"
                              className="doc-list-import-count"
                            >
                              {cur} / {tot}
                              {remaining != null && remaining > 0 ?
                                ` (${remaining} left)`
                              : null}
                            </Text>
                          : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            : null}
          </Sider>
          <Content className="app-main">
            <div className="main-column">
              {!selectedId ?
                <div className="main-empty">
                  <Empty description="Select a document from the sidebar" />
                </div>
              : <>
                  {selectedDoc ?
                    <div className="main-doc-header">
                      <div
                        className={
                          docTitleEditing ?
                            "main-doc-title-slot main-doc-title-slot--editing"
                          : "main-doc-title-slot"
                        }
                      >
                        {docTitleEditing ?
                          savingDocTitle ?
                            <Skeleton.Input
                              active
                              className="main-doc-title-skeleton"
                              aria-label="Saving title"
                            />
                        : <Input
                            variant="borderless"
                            autoFocus
                            maxLength={500}
                            value={docTitleDraft}
                            onChange={(e) => setDocTitleDraft(e.target.value)}
                            onBlur={() => void saveDocumentTitle(docTitleDraft)}
                            onPressEnter={(e) =>
                              (e.target as HTMLInputElement).blur()
                            }
                            aria-label="Document title"
                            className="main-doc-title-input"
                          />
                        : <Title
                            level={4}
                            className="main-doc-title"
                            onClick={() => {
                              setDocTitleDraft(selectedDoc.filename);
                              setDocTitleEditing(true);
                            }}
                          >
                            {selectedDoc.filename}
                          </Title>
                        }
                      </div>
                    </div>
                  : null}
                  <div className="main-filters">
                    <Flex vertical gap="middle" className="main-filters-inner">
                      <Flex
                        align="center"
                        justify="space-between"
                        wrap="wrap"
                        gap="middle"
                      >
                        <Space wrap size="large">
                          <Space>
                            <Text>Hide slides with no highlights</Text>
                            <Switch checked={hideNoHl} onChange={setHideNoHl} />
                          </Space>
                          <Space>
                            <Text>Show starred only</Text>
                            <Switch
                              checked={starredOnly}
                              onChange={setStarredOnly}
                            />
                          </Space>
                          <Button
                            icon={<SyncOutlined />}
                            loading={rescanning}
                            disabled={
                              processingBusy ||
                              !(selectedDoc?.original_stored ?? false)
                            }
                            title={
                              (selectedDoc?.original_stored ?? false) ?
                                "Re-extract highlights from the stored PDF"
                              : "No stored PDF (re-upload this file to enable rescan)"
                            }
                            onClick={() => void rescanDocument()}
                          >
                            Rescan document
                          </Button>
                        </Space>
                        <Text type="secondary">
                          {visible.length} of {slides.length} slides shown
                        </Text>
                      </Flex>
                      <Input
                        allowClear
                        className="main-slide-search"
                        placeholder="Search text on slides…"
                        prefix={<SearchOutlined />}
                        value={slideSearch}
                        onChange={(e) => setSlideSearch(e.target.value)}
                        aria-label="Filter slides by text on the page"
                      />
                    </Flex>
                  </div>
                  <div className="main-slides-wrap">
                    <div ref={mainSlidesRef} className="main-slides">
                      <Spin spinning={loadingSlides}>
                        {visible.length === 0 ?
                          <Empty description="No slides match filters" />
                        : visible.map((s, i) => (
                            <div
                              key={s.slide_id}
                              ref={i === 0 ? firstSlideRef : undefined}
                              className="slide-card-outer"
                            >
                              <SlideCard
                                slide={s}
                                hideBusy={pendingHideSlideIds.has(s.slide_id)}
                                addNoteBusy={pendingAddNoteSlideIds.has(
                                  s.slide_id,
                                )}
                                pendingStarIds={pendingStarIds}
                                pendingDeleteIds={pendingDeleteIds}
                                onHide={() =>
                                  void patchHide(s.slide_id, !s.is_hidden)
                                }
                                onToggleStarred={patchStarred}
                                onDelete={removeHighlight}
                                onSaveText={saveHighlightText}
                                onAddNote={() =>
                                  void addHighlightNote(s.slide_id)
                                }
                                focusNewNoteHighlightId={focusNewNoteHighlightId}
                                onNewNoteFocusHandled={clearNewNoteFocus}
                                onImageClick={() =>
                                  setLightbox(
                                    `${window.location.origin}${s.image_url}`,
                                  )
                                }
                              />
                            </div>
                          ))
                        }
                      </Spin>
                    </div>
                    {showScrollTopFab ?
                      <Tooltip title="Back to top" placement="left">
                        <Button
                          type="primary"
                          shape="circle"
                          size="large"
                          icon={<ArrowUpOutlined />}
                          className="main-slides-scroll-top-fab"
                          onClick={scrollSlidesToTop}
                          aria-label="Scroll slides back to top"
                        />
                      </Tooltip>
                    : null}
                  </div>
                </>
              }
            </div>
          </Content>
        </Layout>
        <Modal
          open={!!lightbox}
          footer={null}
          onCancel={() => setLightbox(null)}
          width="90vw"
          centered
          styles={{ body: { padding: 0, textAlign: "center" } }}
        >
          {lightbox ?
            <img
              src={lightbox}
              alt=""
              style={{ maxWidth: "100%", height: "auto" }}
            />
          : null}
        </Modal>
      </Layout>
    </>
  );
}

function SlideCard({
  slide,
  hideBusy,
  addNoteBusy,
  pendingStarIds,
  pendingDeleteIds,
  onHide,
  onToggleStarred,
  onDelete,
  onSaveText,
  onAddNote,
  focusNewNoteHighlightId,
  onNewNoteFocusHandled,
  onImageClick,
}: {
  slide: SlideRow;
  hideBusy: boolean;
  addNoteBusy: boolean;
  pendingStarIds: Set<number>;
  pendingDeleteIds: Set<number>;
  onHide: () => void;
  onToggleStarred: (id: number, starred: boolean) => void | Promise<void>;
  onDelete: (id: number) => void | Promise<void>;
  onSaveText: (id: number, text: string) => Promise<void>;
  onAddNote: () => void;
  focusNewNoteHighlightId: number | null;
  onNewNoteFocusHandled: () => void;
  onImageClick: () => void;
}) {
  const imageColRef = useRef<HTMLDivElement>(null);
  const [notesMaxHeight, setNotesMaxHeight] = useState<number | undefined>(
    undefined,
  );

  const updateNotesMaxHeight = useCallback(() => {
    const el = imageColRef.current;
    if (!el) return;
    const h = Math.round(el.getBoundingClientRect().height);
    if (h > 0) {
      setNotesMaxHeight(h);
    }
  }, []);

  useLayoutEffect(() => {
    if (slide.is_hidden) return;
    const el = imageColRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      updateNotesMaxHeight();
    });
    ro.observe(el);
    updateNotesMaxHeight();
    return () => {
      ro.disconnect();
    };
  }, [slide.is_hidden, slide.slide_id, slide.image_url, updateNotesMaxHeight]);

  if (slide.is_hidden) {
    return (
      <Card size="small" style={{ marginBottom: 12 }}>
        <Flex justify="space-between" align="center">
          <Text type="secondary">Slide {slide.page_number} — hidden</Text>
          <Button
            size="small"
            loading={hideBusy}
            icon={hideBusy ? undefined : <EyeOutlined />}
            onClick={onHide}
          >
            Show
          </Button>
        </Flex>
      </Card>
    );
  }

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Flex justify="space-between" align="center">
          <Text strong>Slide {slide.page_number}</Text>
          <Button
            size="small"
            type="text"
            loading={hideBusy}
            icon={hideBusy ? undefined : <EyeInvisibleOutlined />}
            onClick={onHide}
            aria-label="Hide slide"
          />
        </Flex>
      }
    >
      <Row gutter={16} className="slide-card-body-row" align="top">
        <Col xs={24} md={14} lg={15}>
          <div ref={imageColRef} className="slide-card-image-col">
            <img
              className="slide-image"
              src={slide.image_url}
              alt={`Slide ${slide.page_number}`}
              onClick={onImageClick}
              onLoad={updateNotesMaxHeight}
            />
          </div>
        </Col>
        <Col xs={24} md={10} lg={9}>
          <div
            className="slide-notes-col"
            style={
              notesMaxHeight != null ?
                { height: notesMaxHeight, maxHeight: notesMaxHeight }
              : undefined
            }
          >
            <div className="slide-notes-panel">
              <div className="slide-notes-scroll">
                {slide.highlights.length === 0 ?
                  <Text type="secondary">No highlights from PDF</Text>
                : <List
                    className="slide-notes-list"
                    size="small"
                    split={false}
                    rowKey="id"
                    dataSource={slide.highlights}
                    renderItem={(h: Highlight) => (
                      <List.Item>
                        <HighlightTextarea
                          key={h.id}
                          highlightId={h.id}
                          value={h.text}
                          isStarred={h.is_very_important}
                          onSave={onSaveText}
                          onToggleStarred={onToggleStarred}
                          onDelete={onDelete}
                          starSaving={pendingStarIds.has(h.id)}
                          deleteSaving={pendingDeleteIds.has(h.id)}
                          autoFocus={focusNewNoteHighlightId === h.id}
                          onAutoFocusDone={onNewNoteFocusHandled}
                        />
                      </List.Item>
                    )}
                  />
                }
              </div>
              <div className="slide-notes-add-wrap">
                <Button
                  type="dashed"
                  block
                  loading={addNoteBusy}
                  icon={addNoteBusy ? undefined : <PlusOutlined />}
                  onClick={onAddNote}
                  aria-label="Add note"
                >
                  Add note
                </Button>
              </div>
            </div>
          </div>
        </Col>
      </Row>
    </Card>
  );
}
