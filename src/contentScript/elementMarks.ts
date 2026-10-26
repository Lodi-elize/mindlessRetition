import type { Annotation, FromContentMessage } from '../shared/types'

type Sender = (message: FromContentMessage) => void

const ROOT_ID = 'mr-element-mark-layer'
const COLOR = '#f59e0b'
const FONT = 'system-ui,-apple-system,"Segoe UI",sans-serif'

interface MarkEntry {
  annotation: Annotation
  element: Element
  box: HTMLDivElement
  badge: HTMLButtonElement
}

let sendMessage: Sender = () => undefined
const marks = new Map<string, MarkEntry>()

let root: HTMLDivElement | null = null
let frame = 0
let pollTimer: number | undefined
let observer: MutationObserver | null = null

export function initElementMarks(sender: Sender) {
  sendMessage = sender
}

function ensureRoot(): HTMLDivElement {
  if (root?.isConnected) return root

  root = document.createElement('div')
  root.id = ROOT_ID
  root.style.cssText = [
    'all:initial',
    'display:block',
    'position:fixed',
    'inset:0',
    'z-index:2147483644',
    'pointer-events:none',
    'overflow:hidden',
    'contain:layout style',
  ].join(';')
  document.documentElement.appendChild(root)
  return root
}

function updatePositions() {
  for (const entry of marks.values()) {
    if (!entry.element.isConnected) {
      entry.box.style.display = 'none'
      continue
    }

    const rect = entry.element.getBoundingClientRect()
    if (
      rect.width < 1 ||
      rect.height < 1 ||
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      entry.box.style.display = 'none'
      continue
    }

    entry.box.style.display = 'block'
    entry.box.style.transform = `translate(${rect.left}px, ${rect.top}px)`
    entry.box.style.width = `${rect.width}px`
    entry.box.style.height = `${rect.height}px`
    entry.badge.style.transform = rect.top >= 22 ? 'translate(0,-100%)' : 'none'
  }
}

function scheduleUpdate() {
  if (frame || !marks.size) return
  frame = window.requestAnimationFrame(() => {
    frame = 0
    updatePositions()
  })
}

function startTracking() {
  if (observer) return

  window.addEventListener('scroll', scheduleUpdate, true)
  window.addEventListener('resize', scheduleUpdate)
  observer = new MutationObserver(scheduleUpdate)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  pollTimer = window.setInterval(scheduleUpdate, 500)
}

function stopTracking() {
  if (frame) {
    window.cancelAnimationFrame(frame)
    frame = 0
  }
  if (pollTimer != null) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
  observer?.disconnect()
  observer = null
  window.removeEventListener('scroll', scheduleUpdate, true)
  window.removeEventListener('resize', scheduleUpdate)
}

function removeEntry(entry: MarkEntry) {
  entry.box.remove()
  marks.delete(entry.annotation.id)
}

export function resolveElement(selector: string): Element | null {
  if (!selector) return null
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

/** 在页面上渲染一条元素标注；同一 id 重复调用会更新定位 */
export function renderElementMark(annotation: Annotation, element: Element): boolean {
  if (!document.documentElement.contains(element)) return false

  const existing = marks.get(annotation.id)
  if (existing) {
    existing.annotation = annotation
    existing.element = element
    existing.badge.title = annotation.note || annotation.text || annotation.id
    scheduleUpdate()
    return true
  }

  const layer = ensureRoot()

  const box = document.createElement('div')
  box.style.cssText = [
    'all:initial',
    'display:block',
    'position:absolute',
    'left:0',
    'top:0',
    'box-sizing:border-box',
    `border:2px dashed ${COLOR}`,
    'border-radius:4px',
    'background:rgba(245,158,11,.08)',
    'box-shadow:0 0 0 1px rgba(255,255,255,.35) inset',
    'pointer-events:none',
  ].join(';')

  const badge = document.createElement('button')
  badge.type = 'button'
  badge.textContent = '✎'
  badge.title = annotation.note || annotation.text || '元素标注'
  badge.setAttribute('aria-label', '查看元素标注')
  badge.style.cssText = [
    'all:initial',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'position:absolute',
    'left:0',
    'top:0',
    'width:18px',
    'height:18px',
    'border-radius:4px',
    `background:${COLOR}`,
    'color:#fff',
    `font:700 11px/1 ${FONT}`,
    'cursor:pointer',
    'pointer-events:auto',
    'box-shadow:0 1px 4px rgba(0,0,0,.3)',
  ].join(';')

  const entry: MarkEntry = { annotation, element, box, badge }
  badge.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    sendMessage({ type: 'ANNOTATION_CLICKED', id: annotation.id })
  })

  box.appendChild(badge)
  layer.appendChild(box)
  marks.set(annotation.id, entry)

  startTracking()
  updatePositions()
  return true
}

export function removeElementMark(id: string) {
  const entry = marks.get(id)
  if (!entry) return
  removeEntry(entry)
  if (!marks.size) {
    stopTracking()
    root?.remove()
    root = null
  }
}

export function clearElementMarks() {
  for (const entry of Array.from(marks.values())) removeEntry(entry)
  stopTracking()
  root?.remove()
  root = null
}

export function focusElementMark(id: string): boolean {
  const entry = marks.get(id)
  if (!entry) return false

  if (entry.element.isConnected) {
    entry.element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  updatePositions()
  entry.box.animate(
    [
      { boxShadow: '0 0 0 3px rgba(245,158,11,.95)' },
      { boxShadow: '0 0 0 14px rgba(245,158,11,0)' },
    ],
    { duration: 1100, easing: 'ease-out' },
  )
  return true
}
