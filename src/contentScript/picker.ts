import type { FromContentMessage } from '../shared/types'

type Sender = (message: FromContentMessage) => void

let sendMessage: Sender = () => undefined
let active = false
let requestId = ''
let overlay: HTMLDivElement | null = null
let hint: HTMLDivElement | null = null
let banner: HTMLDivElement | null = null
let cursorStyle: HTMLStyleElement | null = null
let current: Element | null = null
/** 点选期间临时压制的页面样式，结束后还原 */
let prevUserSelect = ''
let prevCursor = ''

export function initPicker(sender: Sender) {
  sendMessage = sender
}

function uniqueIdSelector(element: Element): string | null {
  if (!element.id) return null
  const selector = `#${CSS.escape(element.id)}`
  try {
    return document.querySelectorAll(selector).length === 1 ? selector : null
  } catch {
    return null
  }
}

export function buildSelector(element: Element): string {
  const ownId = uniqueIdSelector(element)
  if (ownId) return ownId

  const classNames = Array.from(element.classList).filter((name) => name && !name.startsWith('mr-'))
  for (const className of classNames.slice(0, 2)) {
    const candidate = `${element.tagName.toLowerCase()}.${CSS.escape(className)}`
    try {
      if (document.querySelectorAll(candidate).length === 1) return candidate
    } catch {
      /* 忽略非法类名 */
    }
  }

  const parts: string[] = []
  let node: Element | null = element
  while (node && node !== document.documentElement) {
    const ancestorId = uniqueIdSelector(node)
    if (ancestorId) {
      parts.unshift(ancestorId)
      break
    }

    let part = node.tagName.toLowerCase()
    const ownClasses = Array.from(node.classList).filter((name) => name && !name.startsWith('mr-'))
    if (ownClasses.length) part += `.${CSS.escape(ownClasses[0])}`

    const parent: Element | null = node.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (child: Element) => child.tagName === node!.tagName,
      )
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
    }

    parts.unshift(part)
    if (parts.length >= 5) break
    node = parent
  }

  return parts.join(' > ')
}

function updateHint(rect: DOMRect) {
  if (!hint || !current) return

  const tag = current.tagName.toLowerCase()
  hint.textContent = `<${tag}> · 点击选择 · Esc 取消`
  hint.style.top = rect.top >= 28 ? '-24px' : '2px'
}

function updateOverlay() {
  if (!overlay || !current) return

  const rect = current.getBoundingClientRect()
  overlay.style.display = 'block'
  overlay.style.left = `${rect.left}px`
  overlay.style.top = `${rect.top}px`
  overlay.style.width = `${rect.width}px`
  overlay.style.height = `${rect.height}px`
  updateHint(rect)
}

function setCandidate(element: Element) {
  current = element
  updateOverlay()
}

function confirmPick() {
  if (!current) return
  if (!document.documentElement.contains(current)) {
    finish(false)
    return
  }

  const payload: FromContentMessage = {
    type: 'PICKED',
    requestId,
    selector: buildSelector(current),
    tag: current.tagName.toLowerCase(),
    text: (current.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
  }
  finish(true)
  sendMessage(payload)
}

function onMouseMove(event: MouseEvent) {
  if (!overlay) return

  const element = document.elementFromPoint(event.clientX, event.clientY)
  if (!element || element === overlay || overlay.contains(element)) return
  if (!(element instanceof Element) || !document.documentElement.contains(element)) return

  // 始终跟随鼠标下方最深的元素：点在哪里就选哪里
  if (current === element) return

  setCandidate(element)
}

function onClick(event: MouseEvent) {
  // 自动化脚本派发的合成点击不应被当成“点选元素”
  if (!event.isTrusted) return
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()

  if (!current) {
    const element = document.elementFromPoint(event.clientX, event.clientY) as Element | null
    if (!element) {
      finish(false)
      return
    }
    setCandidate(element)
  }

  confirmPick()
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  finish(false)
}

/** 点选期间阻止原生文字拖选、图片/链接拖拽，避免出现「只能选文字」 */
function blockNativeSelection(event: Event) {
  event.preventDefault()
  event.stopPropagation()
}

function finish(keepQuiet: boolean) {
  if (!active) return
  active = false
  current = null
  document.removeEventListener('mousemove', onMouseMove, true)
  document.removeEventListener('click', onClick, true)
  document.removeEventListener('keydown', onKeyDown, true)
  document.removeEventListener('mousedown', blockNativeSelection, true)
  document.removeEventListener('selectstart', blockNativeSelection, true)
  document.removeEventListener('dragstart', blockNativeSelection, true)
  document.documentElement.style.userSelect = prevUserSelect
  document.documentElement.style.cursor = prevCursor
  overlay?.remove()
  overlay = null
  hint = null
  banner?.remove()
  banner = null
  cursorStyle?.remove()
  cursorStyle = null
  if (!keepQuiet) sendMessage({ type: 'PICK_CANCELED', requestId })
}

export function startPicker(id: string) {
  if (active) finish(true)
  active = true
  requestId = id
  current = null

  overlay = document.createElement('div')
  overlay.id = 'mr-picker-overlay'
  overlay.style.cssText = [
    'position:fixed',
    'display:none',
    'z-index:2147483646',
    'pointer-events:none',
    'border:2px solid #3b82f6',
    'background:rgba(59,130,246,.12)',
    'border-radius:3px',
    'box-sizing:border-box',
    'box-shadow:0 0 0 1px rgba(255,255,255,.5) inset',
    'transition:all .04s linear',
  ].join(';')

  hint = document.createElement('div')
  hint.id = 'mr-picker-hint'
  hint.style.cssText = [
    'position:absolute',
    'left:0',
    'top:-24px',
    'padding:2px 6px',
    'border-radius:4px',
    'background:#111827',
    'color:#f9fafb',
    'font:500 11px/16px system-ui,-apple-system,"Segoe UI",sans-serif',
    'white-space:nowrap',
    'box-shadow:0 2px 8px rgba(0,0,0,.25)',
    'pointer-events:none',
  ].join(';')
  overlay.appendChild(hint)

  document.documentElement.appendChild(overlay)

  // 顶部常驻提示：不依赖鼠标是否已经移到候选元素上。
  // 点选会同时派发到所有 frame，只在最外层文档显示一次，避免每个 iframe 各出现一条。
  if (window.top === window.self) {
    banner = document.createElement('div')
    banner.id = 'mr-picker-banner'
    banner.textContent = '点选元素 · 点击选择 · Esc 取消'
    banner.style.cssText = [
      'position:fixed',
      'top:12px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'padding:7px 12px',
      'border-radius:999px',
      'background:rgba(17,24,39,.92)',
      'color:#f9fafb',
      'font:600 12px/18px system-ui,-apple-system,"Segoe UI",sans-serif',
      'white-space:nowrap',
      'max-width:90vw',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'box-shadow:0 4px 16px rgba(0,0,0,.3)',
      'pointer-events:none',
    ].join(';')
    document.documentElement.appendChild(banner)
  }

  // 强制整页显示十字光标，让「正在点选元素」这件事一眼可见
  cursorStyle = document.createElement('style')
  cursorStyle.id = 'mr-picker-cursor'
  cursorStyle.textContent = '*{cursor:crosshair !important;}'
  document.documentElement.appendChild(cursorStyle)

  // 点选时暂时禁止页面文字选择和光标变化
  prevUserSelect = document.documentElement.style.userSelect
  prevCursor = document.documentElement.style.cursor
  document.documentElement.style.userSelect = 'none'
  document.documentElement.style.cursor = 'crosshair'

  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('mousedown', blockNativeSelection, true)
  document.addEventListener('selectstart', blockNativeSelection, true)
  document.addEventListener('dragstart', blockNativeSelection, true)
}

export function cancelPicker() {
  finish(false)
}

export function isPicking() {
  return active
}
