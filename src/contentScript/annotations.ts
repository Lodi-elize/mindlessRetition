import {
  pageKey,
  STORAGE_ANNOTATIONS,
  type Annotation,
  type AnnotationAnchor,
  type CreateAnnotationResponse,
  type FromContentMessage,
} from '../shared/types'
import {
  clearElementMarks,
  focusElementMark,
  removeElementMark,
  renderElementMark,
  resolveElement,
} from './elementMarks'

export const HIGHLIGHT_CLASS = 'mr-annotation-mark'

const MARK_STYLE: Record<string, string> = {
  'background-color': 'rgba(250, 204, 21, 0.45)',
  'background-image': 'none',
  color: 'inherit',
  'border-radius': '2px',
  'box-shadow': '0 0 0 1px rgba(234, 179, 8, 0.75)',
  cursor: 'pointer',
  'text-decoration': 'none',
}

type Sender = (message: FromContentMessage) => void

let sendMessage: Sender = () => undefined
let savedRange: Range | null = null
let savedText = ''
let selectionTimer: number | undefined
let applying = false
const notes = new Map<string, string>()
let tooltip: HTMLDivElement | null = null

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

function readAnnotations(): Promise<Annotation[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_ANNOTATIONS, (result) => {
      const list = result?.[STORAGE_ANNOTATIONS]
      resolve(Array.isArray(list) ? (list as Annotation[]) : [])
    })
  })
}

/* ------------------------------------------------------------------ */
/* 选区                                                                */
/* ------------------------------------------------------------------ */

export function getSelectionText(): string {
  if (savedRange && savedText && savedRange.startContainer.isConnected) return savedText
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return ''
  return selection.toString().trim()
}

function clearSavedSelection(notify = true) {
  if (!savedText) return
  savedText = ''
  savedRange = null
  if (notify) sendMessage({ type: 'SELECTION_CHANGED', text: '' })
}

function scheduleSelectionCapture() {
  window.clearTimeout(selectionTimer)
  selectionTimer = window.setTimeout(() => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      clearSavedSelection()
      return
    }
    const text = selection.toString().trim()
    if (!text) {
      clearSavedSelection()
      return
    }
    const range = selection.getRangeAt(0).cloneRange()
    if (!range.startContainer.isConnected) return
    savedRange = range
    savedText = text
    sendMessage({ type: 'SELECTION_CHANGED', text })
  }, 60)
}

/* ------------------------------------------------------------------ */
/* XPath / 范围定位                                                     */
/* ------------------------------------------------------------------ */

function nodeXPath(node: Node): string {
  if (node.nodeType === Node.DOCUMENT_NODE) return ''
  const parent = node.parentNode
  if (!parent) return ''

  const parentPath = nodeXPath(parent)

  if (node.nodeType === Node.TEXT_NODE) {
    let index = 1
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (sibling.nodeType === Node.TEXT_NODE) index += 1
    }
    return `${parentPath}/text()[${index}]`
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element
    let index = 1
    for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.nodeName === element.nodeName) index += 1
    }
    return `${parentPath}/${element.nodeName.toLowerCase()}[${index}]`
  }

  return parentPath
}

interface TextSegment {
  node: Text
  start: number
  end: number
}

interface TextIndex {
  full: string
  segments: TextSegment[]
}

/**
 * 把页面正文拼成一段连续文本，并记录每个文本节点对应的区间。
 * skipHighlights = false 时包含已高亮文字，因此索引偏移不会因插入 <mark> 而改变。
 */
function buildTextIndex(skipHighlights: boolean): TextIndex {
  if (!document.body) return { full: '', segments: [] }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('#mr-annotation-tooltip,script,style,noscript,textarea')) {
        return NodeFilter.FILTER_REJECT
      }
      if (skipHighlights && parent.closest(`mark.${HIGHLIGHT_CLASS}`)) {
        return NodeFilter.FILTER_REJECT
      }
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })

  const segments: TextSegment[] = []
  let full = ''
  let node = walker.nextNode()
  while (node) {
    const text = node as Text
    const value = text.nodeValue ?? ''
    segments.push({ node: text, start: full.length, end: full.length + value.length })
    full += value
    node = walker.nextNode()
  }

  return { full, segments }
}

/** 把 DOM 边界点换算成整页文本偏移 */
function boundaryToOffset(index: TextIndex, container: Node, offset: number): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const segment = index.segments.find((item) => item.node === container)
    if (!segment) return null
    return segment.start + Math.min(Math.max(0, offset), segment.node.length)
  }

  if (container.nodeType === Node.ELEMENT_NODE) {
    const limit = container.childNodes.length
    const safe = Math.min(Math.max(0, offset), limit)

    if (safe < limit) {
      const probe = document.createRange()
      probe.setStart(container, safe)
      probe.setEnd(container, safe + 1)
      for (const segment of index.segments) {
        try {
          if (probe.intersectsNode(segment.node)) return segment.start
        } catch {
          /* 忽略失效节点 */
        }
      }
      return null
    }

    let result: number | null = null
    for (const segment of index.segments) {
      if (container.contains(segment.node)) result = segment.end
    }
    return result
  }

  return null
}

/** 把整页文本偏移还原成 DOM Range */
function rangeFromOffsets(index: TextIndex, start: number, end: number): Range | null {
  const locate = (position: number): { node: Text; offset: number } | null => {
    for (const segment of index.segments) {
      if (position >= segment.start && position < segment.end) {
        return { node: segment.node, offset: position - segment.start }
      }
    }
    const last = index.segments[index.segments.length - 1]
    if (last && position === last.end) return { node: last.node, offset: last.node.length }
    return null
  }

  const startPoint = locate(start)
  const endPoint = locate(end)
  if (!startPoint || !endPoint) return null

  try {
    const range = document.createRange()
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)
    return range
  } catch {
    return null
  }
}

export function captureAnchor(range: Range): AnnotationAnchor {
  const anchor: AnnotationAnchor = {
    startXpath: nodeXPath(range.startContainer),
    startOffset: range.startOffset,
    endXpath: nodeXPath(range.endContainer),
    endOffset: range.endOffset,
  }

  // 记录去空白后的文本偏移，作为跨刷新最可靠的定位依据
  const index = buildTextIndex(false)
  const start = boundaryToOffset(index, range.startContainer, range.startOffset)
  const end = boundaryToOffset(index, range.endContainer, range.endOffset)
  if (start != null && end != null && end >= start) {
    const raw = index.full.slice(start, end)
    const leading = raw.length - raw.trimStart().length
    const trailing = raw.trimEnd().length
    if (trailing > leading) anchor.textOffset = start + leading
  }

  return anchor
}

function resolveXPath(path: string): Node | null {
  if (!path) return null
  try {
    const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
    return result.singleNodeValue
  } catch {
    return null
  }
}

function maxOffset(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length ?? 0
  return node.childNodes.length
}

function resolveRangeFromAnchor(annotation: Annotation): Range | null {
  const anchor = annotation.anchor
  if (!anchor) return null

  const start = resolveXPath(anchor.startXpath)
  const end = resolveXPath(anchor.endXpath)
  if (!start || !end) return null

  try {
    const range = document.createRange()
    range.setStart(start, Math.min(Math.max(0, anchor.startOffset), maxOffset(start)))
    range.setEnd(end, Math.min(Math.max(0, anchor.endOffset), maxOffset(end)))
    if (range.toString().trim() === annotation.text.trim()) return range
  } catch {
    return null
  }
  return null
}

function resolveRangeFromTextOffset(annotation: Annotation): Range | null {
  const offset = annotation.anchor?.textOffset
  if (offset == null) return null

  const index = buildTextIndex(false)
  const end = offset + annotation.text.length
  if (index.full.slice(offset, end) !== annotation.text) return null
  return rangeFromOffsets(index, offset, end)
}

/** 在正文中按文本查找选区，作为所有精确定位失效时的兜底 */
function findRangeByText(target: string): Range | null {
  const needle = target.trim()
  if (!needle) return null

  const index = buildTextIndex(true)
  const position = index.full.indexOf(needle)
  if (position < 0) return null
  return rangeFromOffsets(index, position, position + needle.length)
}

function resolveAnnotationRange(annotation: Annotation): Range | null {
  return (
    resolveRangeFromTextOffset(annotation) ??
    resolveRangeFromAnchor(annotation) ??
    findRangeByText(annotation.text)
  )
}

/* ------------------------------------------------------------------ */
/* 高亮渲染                                                             */
/* ------------------------------------------------------------------ */

function applyMarkStyle(mark: HTMLElement) {
  mark.style.setProperty('background-color', MARK_STYLE['background-color'], 'important')
  mark.style.setProperty('background-image', MARK_STYLE['background-image'], 'important')
  mark.style.setProperty('color', MARK_STYLE.color, 'important')
  mark.style.setProperty('border-radius', MARK_STYLE['border-radius'], 'important')
  mark.style.setProperty('box-shadow', MARK_STYLE['box-shadow'], 'important')
  mark.style.setProperty('cursor', MARK_STYLE.cursor, 'important')
  mark.style.setProperty('text-decoration', MARK_STYLE['text-decoration'], 'important')
}

function highlightRange(annotation: Annotation, range: Range): boolean {
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer
  if (!root) return false

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const segments: { node: Text; start: number; end: number }[] = []

  let node = walker.nextNode()
  while (node) {
    const text = node as Text
    const parent = text.parentElement
    if (parent && !parent.closest(`mark.${HIGHLIGHT_CLASS}`) && text.nodeValue) {
      let intersects = false
      try {
        intersects = range.intersectsNode(text)
      } catch {
        intersects = false
      }
      if (intersects) {
        const start = text === range.startContainer ? range.startOffset : 0
        const end = text === range.endContainer ? range.endOffset : text.nodeValue.length
        if (end > start) segments.push({ node: text, start, end })
      }
    }
    node = walker.nextNode()
  }

  let wrapped = false
  for (const segment of segments) {
    let { node: target, start, end } = segment
    if (!target.isConnected) continue

    if (start > 0) {
      target = target.splitText(start)
      end -= start
    }
    if (end < target.length) target.splitText(end)
    if (!target.length) continue

    const mark = document.createElement('mark')
    mark.className = HIGHLIGHT_CLASS
    mark.dataset.mrId = annotation.id
    applyMarkStyle(mark)
    target.parentNode?.replaceChild(mark, target)
    mark.appendChild(target)
    wrapped = true
  }

  notes.set(annotation.id, annotation.note)
  return wrapped
}

function removeHighlight(id: string) {
  notes.delete(id)
  removeElementMark(id)
  const marks = document.querySelectorAll<HTMLElement>(
    `mark.${HIGHLIGHT_CLASS}[data-mr-id="${CSS.escape(id)}"]`,
  )
  const parents = new Set<Node>()
  marks.forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    parents.add(parent)
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''))
  })
  parents.forEach((parent) => parent.normalize())
}

function clearAllHighlights() {
  clearElementMarks()
  const marks = document.querySelectorAll<HTMLElement>(`mark.${HIGHLIGHT_CLASS}`)
  const parents = new Set<Node>()
  marks.forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    parents.add(parent)
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''))
  })
  parents.forEach((parent) => parent.normalize())
  notes.clear()
}

function compareRangesByStartDesc(a: Range, b: Range): number {
  return b.compareBoundaryPoints(Range.START_TO_START, a)
}

/** 页面加载 / SPA 切页后，从 storage 还原本页标注 */
export async function applyStoredAnnotations() {
  if (applying || !document.body) return
  applying = true
  try {
    const all = await readAnnotations()
    const key = pageKey(location.href)
    // iframe 内的标注按 frame 自身地址匹配，顶层标注仍按页面地址匹配
    const mine = all.filter(
      (annotation) => pageKey(annotation.frameUrl ?? annotation.url) === key,
    )
    const pending: { annotation: Annotation; range: Range }[] = []

    for (const annotation of mine) {
      notes.set(annotation.id, annotation.note)

      if (annotation.mode === 'element' && annotation.element) {
        const element = resolveElement(annotation.element.selector)
        if (element) renderElementMark(annotation, element)
        continue
      }

      const existing = document.querySelector(`mark[data-mr-id="${CSS.escape(annotation.id)}"]`)
      if (existing) continue
      const range = resolveAnnotationRange(annotation)
      if (range) pending.push({ annotation, range })
    }

    // 先解析全部范围再统一写入 DOM，避免前一个高亮影响后一个定位
    pending.sort((a, b) => compareRangesByStartDesc(a.range, b.range))
    for (const item of pending) highlightRange(item.annotation, item.range)
  } finally {
    applying = false
  }
}

/* ------------------------------------------------------------------ */
/* 浮动提示                                                             */
/* ------------------------------------------------------------------ */

function ensureTooltip(): HTMLDivElement {
  if (tooltip?.isConnected) return tooltip
  tooltip = document.createElement('div')
  tooltip.id = 'mr-annotation-tooltip'
  tooltip.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'max-width:280px',
    'padding:8px 10px',
    'border-radius:8px',
    'background:#111827',
    'color:#f9fafb',
    'font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif',
    'box-shadow:0 10px 30px rgba(0,0,0,.3)',
    'pointer-events:none',
    'opacity:0',
    'transition:opacity .12s ease',
    'white-space:pre-wrap',
    'word-break:break-word',
  ].join(';')
  document.documentElement.appendChild(tooltip)
  return tooltip
}

function showTooltip(mark: HTMLElement, note: string) {
  const element = ensureTooltip()
  element.textContent = note || '（无备注）'
  element.style.opacity = '1'
  element.style.left = '0px'
  element.style.top = '0px'

  const rect = mark.getBoundingClientRect()
  const width = element.offsetWidth
  const height = element.offsetHeight
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - width / 2),
    Math.max(8, window.innerWidth - width - 8),
  )
  let top = rect.top - height - 8
  if (top < 8) top = rect.bottom + 8
  element.style.left = `${left}px`
  element.style.top = `${top}px`
}

let hideTooltipTimer: number | undefined

function hideTooltip() {
  window.clearTimeout(hideTooltipTimer)
  if (tooltip) tooltip.style.opacity = '0'
}

function markFromEvent(event: Event): HTMLElement | null {
  const target = event.target
  if (!(target instanceof Element)) return null
  return target.closest(`mark.${HIGHLIGHT_CLASS}`) as HTMLElement | null
}

/* ------------------------------------------------------------------ */
/* 对外操作                                                             */
/* ------------------------------------------------------------------ */

export function createAnnotation(annotation: Annotation): CreateAnnotationResponse {
  if (annotation.mode === 'element' && annotation.element) {
    const element = resolveElement(annotation.element.selector)
    if (!element) {
      return { ok: false, message: '未能在页面中找到该元素，页面可能已经变化' }
    }
    if (!renderElementMark(annotation, element)) {
      return { ok: false, message: '该元素当前无法标注' }
    }
    return { ok: true }
  }

  const range =
    savedRange && savedText === annotation.text && savedRange.startContainer.isConnected
      ? savedRange.cloneRange()
      : findRangeByText(annotation.text)

  if (!range) {
    return { ok: false, message: '未能在页面中定位所选文字，请重新选中后再试' }
  }

  const anchor = captureAnchor(range)

  // 用去空白后的精确偏移重建 Range，避免把首尾空格也涂上高亮
  let targetRange = range
  if (anchor.textOffset != null) {
    const index = buildTextIndex(false)
    const end = anchor.textOffset + annotation.text.length
    if (index.full.slice(anchor.textOffset, end) === annotation.text) {
      targetRange = rangeFromOffsets(index, anchor.textOffset, end) ?? range
    }
  }

  if (!highlightRange(annotation, targetRange)) {
    return { ok: false, message: '这段文字已经被标注过，或当前位置不支持高亮' }
  }
  clearSavedSelection()
  return { ok: true, anchor }
}

export function focusAnnotation(id: string) {
  if (focusElementMark(id)) return

  const mark = document.querySelector<HTMLElement>(
    `mark.${HIGHLIGHT_CLASS}[data-mr-id="${CSS.escape(id)}"]`,
  )
  if (!mark) return
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
  mark.animate(
    [
      { boxShadow: '0 0 0 2px rgba(37,99,235,.95)' },
      { boxShadow: '0 0 0 10px rgba(37,99,235,0)' },
    ],
    { duration: 1100, easing: 'ease-out' },
  )
  showTooltip(mark, notes.get(id) ?? '')
  window.clearTimeout(hideTooltipTimer)
  hideTooltipTimer = window.setTimeout(hideTooltip, 1600)
}

export function initAnnotations(sender: Sender) {
  sendMessage = sender

  document.addEventListener('mouseup', scheduleSelectionCapture, true)
  document.addEventListener('keyup', scheduleSelectionCapture, true)

  document.addEventListener(
    'click',
    (event) => {
      // 只处理真实用户点击，避免拦截自动化脚本派发的 click
      if (!event.isTrusted) return
      const mark = markFromEvent(event)
      if (!mark?.dataset.mrId) return
      event.preventDefault()
      event.stopPropagation()
      sendMessage({ type: 'ANNOTATION_CLICKED', id: mark.dataset.mrId })
    },
    true,
  )

  document.addEventListener(
    'mouseover',
    (event) => {
      const mark = markFromEvent(event)
      if (!mark?.dataset.mrId) return
      showTooltip(mark, notes.get(mark.dataset.mrId) ?? '')
    },
    true,
  )

  document.addEventListener(
    'mouseout',
    (event) => {
      const mark = markFromEvent(event)
      if (!mark) return
      const related = event.relatedTarget
      if (related instanceof Node && mark.contains(related)) return
      hideTooltip()
    },
    true,
  )

  if (document.body) void applyStoredAnnotations()
  window.addEventListener('load', () => void applyStoredAnnotations())

  // SPA 路由切换后清理旧高亮并还原新页面标注
  let lastHref = location.href
  window.setInterval(() => {
    if (location.href === lastHref) return
    lastHref = location.href
    clearSavedSelection(false)
    clearAllHighlights()
    window.setTimeout(() => void applyStoredAnnotations(), 600)
  }, 800)
}

export { removeHighlight, clearAllHighlights }
