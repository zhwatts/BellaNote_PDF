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
  Row,
  Space,
  Spin,
  Switch,
  Tooltip,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  ExportOutlined,
  PlusOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  GlobalOutlined,
  HolderOutlined,
  LoadingOutlined,
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

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || res.statusText);
  }
  return res.json() as Promise<T>;
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
}: {
  doc: DocSummary;
  selected: boolean;
  exportChecked: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onExportCheckChange: (checked: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: doc.id });

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
      }`}
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
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        <Text ellipsis className="doc-list-row-title" style={{ maxWidth: 180 }}>
          {doc.filename}
        </Text>
        <Text type="secondary" className="doc-list-highlight-count">
          {doc.highlight_count} highlights
        </Text>
      </div>
      <Popconfirm
        title="Delete this PDF?"
        description="Slides and highlights will be removed."
        okText="Delete"
        okButtonProps={{ danger: true }}
        onConfirm={onDelete}
        onCancel={(e) => e?.stopPropagation()}
      >
        <Button
          type="text"
          danger
          size="small"
          icon={<DeleteOutlined />}
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
  const [uploading, setUploading] = useState(false);
  const [hideNoHl, setHideNoHl] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
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

  const fileRef = useRef<HTMLInputElement>(null);
  const mainSlidesRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

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
  }, [selectedId]);

  const visible = useMemo(
    () => filterSlides(slides, hideNoHl, starredOnly),
    [slides, hideNoHl, starredOnly],
  );

  const processingUpload = uploading;
  const processingRescan = rescanning;
  const processingBusy = processingUpload || processingRescan;
  const rescanOverlayDescription = "Rescanning highlights from the stored PDF…";

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
      const data = (await res.json()) as UploadResponse;
      for (const w of data.warnings) {
        message.warning(`${w.filename}: ${w.message}`, 8);
      }
      if (data.results.length) {
        const last = data.results[data.results.length - 1]!;
        setSelectedId(last.document_id);
      }
      await loadDocuments();
      message.success("Upload complete");
    } catch (err) {
      message.error(String(err));
    } finally {
      setUploading(false);
    }
  };

  const exportSelected = async () => {
    const ids = Array.from(exportCheckedIds);
    if (ids.length === 0) return;
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
    }
  };

  const patchStarred = async (highlightId: number, starred: boolean) => {
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
    try {
      await apiJson("/documents/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: next.map((d) => d.id) }),
      });
    } catch (e) {
      message.error(String(e));
      void loadDocuments();
    }
  };

  const deleteDocument = async (docId: number) => {
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
                  <GlobalOutlined /> Bella Note
                </Title>
                <Flex gap={8} className="app-sider-toolbar" align="center">
                  <Tooltip title="Import new PDFs">
                    <Button
                      type="primary"
                      className="app-sider-tool-import"
                      icon={<UploadOutlined />}
                      disabled={processingBusy}
                      onClick={onUploadPick}
                    >
                      Import New
                    </Button>
                  </Tooltip>
                  <Tooltip title="Export selected">
                    <Button
                      className="app-sider-tool-export"
                      icon={<ExportOutlined />}
                      disabled={processingBusy || exportCheckedIds.size === 0}
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
                  disabled={processingBusy}
                  onChange={(e) => void onFiles(e)}
                />
              </div>
              <div className="app-sider-divider" role="separator" />
            </div>
            <div className="app-sider-scroll">
              <div className="app-sider-scroll-inner">
                {uploading ?
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
                      <Text type="secondary">Importing PDF…</Text>
                    </div>
                  </div>
                : loadingDocs && docs.length === 0 ?
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
                {docs.length === 0 && !uploading && !loadingDocs ?
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
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                : null}
              </div>
            </div>
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
                          <Input
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
                          Rescan highlights
                        </Button>
                      </Space>
                      <Text type="secondary">
                        {visible.length} of {slides.length} slides shown
                      </Text>
                    </Flex>
                  </div>
                  <div ref={mainSlidesRef} className="main-slides">
                    <Spin spinning={loadingSlides}>
                      {visible.length === 0 ?
                        <Empty description="No slides match filters" />
                      : visible.map((s) => (
                          <SlideCard
                            key={s.slide_id}
                            slide={s}
                            onHide={() =>
                              void patchHide(s.slide_id, !s.is_hidden)
                            }
                            onToggleStarred={patchStarred}
                            onDelete={removeHighlight}
                            onSaveText={saveHighlightText}
                            onAddNote={() => void addHighlightNote(s.slide_id)}
                            focusNewNoteHighlightId={focusNewNoteHighlightId}
                            onNewNoteFocusHandled={clearNewNoteFocus}
                            onImageClick={() =>
                              setLightbox(
                                `${window.location.origin}${s.image_url}`,
                              )
                            }
                          />
                        ))
                      }
                    </Spin>
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
      {processingRescan ?
        <div
          className="app-processing-overlay"
          role="status"
          aria-live="polite"
        >
          <div className="app-processing-overlay-inner">
            <Spin size="large" />
            <Text type="secondary">{rescanOverlayDescription}</Text>
          </div>
        </div>
      : null}
    </>
  );
}

function SlideCard({
  slide,
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
  onHide: () => void;
  onToggleStarred: (id: number, starred: boolean) => void;
  onDelete: (id: number) => void;
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
          <Button size="small" icon={<EyeOutlined />} onClick={onHide}>
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
            icon={<EyeInvisibleOutlined />}
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
                  icon={<PlusOutlined />}
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
