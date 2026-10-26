import { useCallback, useEffect, useRef, useState } from 'react'

import {
  pageKey,
  STORAGE_ANNOTATIONS,
  type Annotation,
  type CreateAnnotationResponse,
  type ElementAnchor,
  type FromContentMessage,
  type SelectionResponse,
} from '../shared/types'
import { getStorage, sendToTab, setStorage } from './messaging'
import { usePickerKeys } from './usePickerKeys'

interface Props {
  tabId: number | null
  pageUrl: string
  connected: boolean
}

interface Feedback {
  kind: 'success' | 'error'
  text: string
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function AnnotationsTab({ tabId, pageUrl, connected }: Props) {
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [selectedText, setSelectedText] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const [picking, setPicking] = useState(false)
  const [pickedElement, setPickedElement] = useState<ElementAnchor | null>(null)
  const [elementNote, setElementNote] = useState('')
  const [savingElement, setSavingElement] = useState(false)

  const itemRefs = useRef(new Map<string, HTMLLIElement>())
  const pickRequestRef = useRef<string | null>(null)
  /** 点选 / 选区所在 frame，保存时把标注写回同一文档 */
  const pickedFrameRef = useRef<{ frameId: number; url: string } | null>(null)
  const selectionFrameRef = useRef<{ frameId: number; url: string } | null>(null)

  const load = useCallback(async () => {
    const data = await getStorage<Record<string, Annotation[] | undefined>>(STORAGE_ANNOTATIONS)
    const list = data[STORAGE_ANNOTATIONS] ?? []
    setAnnotations(
      list
        .filter((annotation) => pageKey(annotation.url) === pageKey(pageUrl))
        .sort((a, b) => b.createdAt - a.createdAt),
    )
  }, [pageUrl])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    // 选区信息来源会随 tab / 页面变化，旧 frame 记录不再可信
    selectionFrameRef.current = null
    if (tabId == null || !connected) {
      setSelectedText('')
      return
    }
    void sendToTab<SelectionResponse>(tabId, { type: 'GET_SELECTION' })
      .then((response) => setSelectedText(response?.text ?? ''))
      .catch(() => setSelectedText(''))
  }, [tabId, connected, pageUrl])

  useEffect(() => {
    const listener = (message: FromContentMessage, sender: chrome.runtime.MessageSender) => {
      if (tabId == null || sender.tab?.id !== tabId) return
      if (message.type === 'SELECTION_CHANGED') {
        selectionFrameRef.current = message.text
          ? { frameId: sender.frameId ?? 0, url: sender.url ?? '' }
          : null
        setSelectedText(message.text)
      } else if (message.type === 'ANNOTATION_CLICKED') {
        setFocusedId(message.id)
      } else if (message.type === 'PICKED') {
        if (pickRequestRef.current !== message.requestId) return
        pickRequestRef.current = null
        pickedFrameRef.current = { frameId: sender.frameId ?? 0, url: sender.url ?? '' }
        setPicking(false)
        setPickedElement({
          selector: message.selector,
          tag: message.tag,
          text: message.text,
        })
        setElementNote('')
        // 点选从所有 frame 同时开始，选中后结束其它 frame 的点选态
        if (tabId != null) {
          void sendToTab(tabId, { type: 'CANCEL_PICK' }).catch(() => undefined)
        }
      } else if (message.type === 'PICK_CANCELED') {
        if (pickRequestRef.current !== message.requestId) return
        pickRequestRef.current = null
        pickedFrameRef.current = null
        setPicking(false)
      }
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [tabId])

  // 页面断开时选择器也随之失效，及时退出点选状态
  useEffect(() => {
    if (connected) return
    pickRequestRef.current = null
    pickedFrameRef.current = null
    setPicking(false)
  }, [connected])

  useEffect(() => {
    if (!focusedId) return
    itemRefs.current.get(focusedId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = window.setTimeout(() => setFocusedId(null), 1800)
    return () => window.clearTimeout(timer)
  }, [focusedId])

  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(null), 2600)
    return () => window.clearTimeout(timer)
  }, [feedback])

  const cancelPicking = useCallback(() => {
    pickRequestRef.current = null
    pickedFrameRef.current = null
    setPicking(false)
  }, [])

  usePickerKeys(picking, tabId, cancelPicking)

  const togglePick = async () => {
    if (tabId == null || !connected) return

    if (picking) {
      pickRequestRef.current = null
      pickedFrameRef.current = null
      setPicking(false)
      void sendToTab(tabId, { type: 'CANCEL_PICK' }).catch(() => undefined)
      return
    }

    const requestId = crypto.randomUUID()
    pickRequestRef.current = requestId
    pickedFrameRef.current = null
    setFeedback(null)
    try {
      await sendToTab(tabId, { type: 'START_PICK', requestId })
      setPickedElement(null)
      setElementNote('')
      setPicking(true)
    } catch (error) {
      pickRequestRef.current = null
      setPicking(false)
      setFeedback({ kind: 'error', text: (error as Error).message })
    }
  }

  const save = async () => {
    if (tabId == null || !selectedText.trim() || saving) return

    const frame = selectionFrameRef.current
    const annotation: Annotation = {
      id: crypto.randomUUID(),
      url: pageUrl,
      ...(frame && frame.frameId !== 0 ? { frameUrl: frame.url } : {}),
      title: '',
      text: selectedText,
      note: note.trim(),
      createdAt: Date.now(),
    }

    setSaving(true)
    try {
      const response = await sendToTab<CreateAnnotationResponse>(
        tabId,
        { type: 'CREATE_ANNOTATION', annotation },
        frame?.frameId ?? 0,
      )
      if (!response?.ok) throw new Error(response?.message || '未能在页面上定位选区')

      if (response.anchor) annotation.anchor = response.anchor

      const data = await getStorage<Record<string, Annotation[] | undefined>>(STORAGE_ANNOTATIONS)
      const list = data[STORAGE_ANNOTATIONS] ?? []
      await setStorage({ [STORAGE_ANNOTATIONS]: [...list, annotation] })

      setNote('')
      setSelectedText('')
      setFeedback({ kind: 'success', text: '标注已保存' })
      await load()
    } catch (error) {
      setFeedback({ kind: 'error', text: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const saveElement = async () => {
    if (tabId == null || !pickedElement || savingElement) return

    const frame = pickedFrameRef.current
    const annotation: Annotation = {
      id: crypto.randomUUID(),
      url: pageUrl,
      ...(frame && frame.frameId !== 0 ? { frameUrl: frame.url } : {}),
      title: '',
      text: pickedElement.text || `<${pickedElement.tag}>`,
      note: elementNote.trim(),
      createdAt: Date.now(),
      mode: 'element',
      element: pickedElement,
    }

    setSavingElement(true)
    try {
      const response = await sendToTab<CreateAnnotationResponse>(
        tabId,
        { type: 'CREATE_ANNOTATION', annotation },
        frame?.frameId ?? 0,
      )
      if (!response?.ok) throw new Error(response?.message || '未能在页面上标注该元素')

      const data = await getStorage<Record<string, Annotation[] | undefined>>(STORAGE_ANNOTATIONS)
      const list = data[STORAGE_ANNOTATIONS] ?? []
      await setStorage({ [STORAGE_ANNOTATIONS]: [...list, annotation] })

      setPickedElement(null)
      setElementNote('')
      pickedFrameRef.current = null
      setFeedback({ kind: 'success', text: '元素标注已保存' })
      await load()
    } catch (error) {
      setFeedback({ kind: 'error', text: (error as Error).message })
    } finally {
      setSavingElement(false)
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm('删除这条标注？')) return

    const data = await getStorage<Record<string, Annotation[] | undefined>>(STORAGE_ANNOTATIONS)
    const list = (data[STORAGE_ANNOTATIONS] ?? []).filter((annotation) => annotation.id !== id)
    await setStorage({ [STORAGE_ANNOTATIONS]: list })

    if (tabId != null) {
      void sendToTab(tabId, { type: 'REMOVE_ANNOTATION', id }).catch(() => undefined)
    }

    setFeedback({ kind: 'success', text: '标注已删除' })
    await load()
  }

  const focus = (id: string) => {
    if (tabId == null) return
    void sendToTab(tabId, { type: 'FOCUS_ANNOTATION', id }).catch(() => undefined)
  }

  return (
    <section className="mr-section">
      <div className="mr-section-head">
        <h2>
          本页标注 <span className="mr-count">{annotations.length}</span>
        </h2>
        <button
          type="button"
          className={`mr-btn mr-btn-ghost mr-pick-toggle${picking ? ' is-active' : ''}`}
          disabled={!connected}
          title={
            connected
              ? '在网页上点击哪个元素，就标注哪个元素'
              : '当前页面未连接内容脚本'
          }
          onClick={() => void togglePick()}
        >
          {picking ? '取消点选' : '⌖ 点选元素'}
        </button>
      </div>

      <div className="mr-card mr-select-card">
        {picking ? (
          <>
            <p className="mr-pick-title">在网页上点击要标注的元素</p>
            <p className="mr-hint">
              鼠标悬停可预览；点击哪里就选中哪里，Esc 取消。
            </p>
            <div className="mr-row-end">
              <button type="button" className="mr-btn mr-btn-ghost" onClick={() => void togglePick()}>
                取消点选
              </button>
            </div>
          </>
        ) : pickedElement ? (
          <>
            <div className="mr-pick-target">
              <span className="mr-anno-tag">&lt;{pickedElement.tag}&gt;</span>
              {pickedElement.text && <span className="mr-pick-text">{pickedElement.text}</span>}
            </div>
            <code className="mr-pick-selector">{pickedElement.selector}</code>
            <textarea
              className="mr-textarea"
              rows={3}
              value={elementNote}
              placeholder="写点备注（可选）"
              onChange={(event) => setElementNote(event.target.value)}
            />
            <div className="mr-row-end mr-row-actions">
              <button
                type="button"
                className="mr-btn mr-btn-ghost"
                onClick={() => {
                  setPickedElement(null)
                  setElementNote('')
                  pickedFrameRef.current = null
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="mr-btn mr-btn-primary"
                disabled={savingElement}
                onClick={() => void saveElement()}
              >
                {savingElement ? '保存中…' : '保存元素标注'}
              </button>
            </div>
          </>
        ) : selectedText ? (
          <>
            <blockquote className="mr-quote">{selectedText}</blockquote>
            <textarea
              className="mr-textarea"
              rows={3}
              value={note}
              placeholder="写点备注（可选）"
              onChange={(event) => setNote(event.target.value)}
            />
            <div className="mr-row-end">
              <button
                type="button"
                className="mr-btn mr-btn-primary"
                disabled={saving || !connected}
                onClick={() => void save()}
              >
                {saving ? '保存中…' : '保存标注'}
              </button>
            </div>
          </>
        ) : (
          <p className="mr-empty-inline">
            在页面上选中文字，或点右上角「⌖ 点选元素」标注网页元素。
          </p>
        )}
      </div>

      {feedback && <div className={`mr-feedback ${feedback.kind}`}>{feedback.text}</div>}

      {annotations.length === 0 ? (
        <p className="mr-empty">本页还没有标注。</p>
      ) : (
        <ul className="mr-list">
          {annotations.map((annotation) => (
            <li
              key={annotation.id}
              ref={(element) => {
                if (element) itemRefs.current.set(annotation.id, element)
                else itemRefs.current.delete(annotation.id)
              }}
              className={`mr-list-item${focusedId === annotation.id ? ' is-focused' : ''}`}
            >
              <div className="mr-list-head">
                <span className="mr-time">
                  {annotation.mode === 'element' ? '元素 · ' : '文字 · '}
                  {formatTime(annotation.createdAt)}
                </span>
                <div className="mr-item-actions">
                  <button
                    type="button"
                    className="mr-btn mr-btn-ghost"
                    onClick={() => focus(annotation.id)}
                  >
                    定位
                  </button>
                  <button
                    type="button"
                    className="mr-btn mr-btn-danger-ghost"
                    onClick={() => void remove(annotation.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
              {annotation.mode === 'element' && annotation.element && (
                <p className="mr-pick-target mr-pick-target-small">
                  <span className="mr-anno-tag">&lt;{annotation.element.tag}&gt;</span>
                  <code className="mr-anno-selector">{annotation.element.selector}</code>
                </p>
              )}
              <p className="mr-note">{annotation.note || '（无备注）'}</p>
              <blockquote className="mr-quote mr-quote-small">{annotation.text}</blockquote>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
