import { useCallback, useEffect, useRef, useState } from 'react'
import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Button, Divider, Flex, Typography } from 'antd'
import {
  BoldOutlined,
  DeleteOutlined,
  ItalicOutlined,
  OrderedListOutlined,
  StarFilled,
  StarOutlined,
  StrikethroughOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import './HighlightTextarea.css'

const { Text } = Typography

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** PDF-extracted plain text or legacy HTML → HTML for TipTap. */
function storedTextToEditorHtml(stored: string): string {
  const raw = stored ?? ''
  const t = raw.trim()
  if (!t) return '<p></p>'
  if (t.includes('<')) return raw
  const parts = raw.split(/\n\n+/)
  return parts
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export function HighlightTextarea({
  highlightId,
  value,
  isStarred,
  onSave,
  onToggleStarred,
  onDelete,
  starSaving = false,
  deleteSaving = false,
  autoFocus = false,
  onAutoFocusDone,
}: {
  highlightId: number
  value: string
  isStarred: boolean
  onSave: (id: number, text: string) => Promise<void>
  onToggleStarred: (id: number, starred: boolean) => void | Promise<void>
  onDelete: (id: number) => void | Promise<void>
  starSaving?: boolean
  deleteSaving?: boolean
  /** Focus editor once after mount (e.g. newly added note). */
  autoFocus?: boolean
  onAutoFocusDone?: () => void
}) {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedRef = useRef<string>(storedTextToEditorHtml(value))

  const runSave = useCallback(
    async (html: string) => {
      if (html === lastSavedRef.current) {
        return
      }
      setStatus('saving')
      try {
        await onSave(highlightId, html)
        lastSavedRef.current = html
        setStatus('saved')
        if (savedClearRef.current) {
          clearTimeout(savedClearRef.current)
        }
        savedClearRef.current = setTimeout(() => {
          setStatus('idle')
          savedClearRef.current = null
        }, 2000)
      } catch {
        setStatus('error')
      }
    },
    [highlightId, onSave],
  )

  const scheduleSave = useCallback(
    (html: string) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        void runSave(html)
      }, 550)
    },
    [runSave],
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Placeholder.configure({
        placeholder: 'Edit highlight or note…',
      }),
    ],
    content: storedTextToEditorHtml(value),
    editorProps: {
      attributes: {
        class: 'highlight-tiptap-editor',
      },
    },
    onUpdate: ({ editor: ed }) => {
      scheduleSave(ed.getHTML())
    },
  })

  useEffect(() => {
    if (!editor) return
    const next = storedTextToEditorHtml(value)
    if (next === lastSavedRef.current) {
      return
    }
    const cur = editor.getHTML()
    if (cur === next) {
      lastSavedRef.current = next
      return
    }
    editor.commands.setContent(next, { emitUpdate: false })
    lastSavedRef.current = next
  }, [editor, highlightId, value])

  useEffect(() => {
    if (!editor || !autoFocus) return
    const id = requestAnimationFrame(() => {
      editor.chain().focus('end').run()
      editor.view.dom.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      onAutoFocusDone?.()
    })
    return () => cancelAnimationFrame(id)
  }, [editor, autoFocus, onAutoFocusDone])

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }
      if (savedClearRef.current) {
        clearTimeout(savedClearRef.current)
      }
    },
    [],
  )

  const flushOnBlur = () => {
    if (!editor) return
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    void runSave(editor.getHTML())
  }

  return (
    <Flex vertical gap={4} style={{ width: '100%' }}>
      <div
        className={
          isStarred
            ? 'highlight-textarea-wrap highlight-textarea-wrap--starred'
            : 'highlight-textarea-wrap'
        }
      >
        {editor ? (
          <>
            <Flex
              wrap="wrap"
              gap={4}
              align="center"
              className="highlight-tiptap-toolbar"
            >
              <Button
                size="small"
                type={editor.isActive('bold') ? 'primary' : 'default'}
                aria-label="Bold"
                icon={<BoldOutlined />}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  editor.chain().focus().toggleBold().run()
                }
              />
              <Button
                size="small"
                type={editor.isActive('italic') ? 'primary' : 'default'}
                aria-label="Italic"
                icon={<ItalicOutlined />}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  editor.chain().focus().toggleItalic().run()
                }
              />
              <Button
                size="small"
                type={editor.isActive('strike') ? 'primary' : 'default'}
                aria-label="Strikethrough"
                icon={<StrikethroughOutlined />}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  editor.chain().focus().toggleStrike().run()
                }
              />
              <Button
                size="small"
                type={editor.isActive('bulletList') ? 'primary' : 'default'}
                aria-label="Bullet list"
                icon={<UnorderedListOutlined />}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  editor.chain().focus().toggleBulletList().run()
                }
              />
              <Button
                size="small"
                type={editor.isActive('orderedList') ? 'primary' : 'default'}
                aria-label="Numbered list"
                icon={<OrderedListOutlined />}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  editor.chain().focus().toggleOrderedList().run()
                }
              />
              <Divider type="vertical" className="highlight-toolbar-vdiv" />
              <Button
                size="small"
                type={isStarred ? 'primary' : 'default'}
                aria-label={isStarred ? 'Unstar note' : 'Star note'}
                loading={starSaving}
                icon={
                  starSaving ? undefined : isStarred ? (
                    <StarFilled />
                  ) : (
                    <StarOutlined />
                  )
                }
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void onToggleStarred(highlightId, !isStarred)}
              />
              <Button
                size="small"
                danger
                type="default"
                aria-label="Delete note"
                loading={deleteSaving}
                icon={deleteSaving ? undefined : <DeleteOutlined />}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void onDelete(highlightId)}
              />
            </Flex>
            <div onBlurCapture={flushOnBlur}>
              <EditorContent editor={editor} />
            </div>
          </>
        ) : null}
      </div>
      <Text
        type="secondary"
        className="highlight-textarea-status"
        aria-live="polite"
      >
        {status === 'saving' && 'Saving…'}
        {status === 'saved' && 'Saved'}
        {status === 'error' && 'Could not save — try again'}
        {status === 'idle' && '\u00a0'}
      </Text>
    </Flex>
  )
}
