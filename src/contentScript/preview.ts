import type { AutomationAction, AutomationStep } from '../shared/types'

const ACTION_LABELS: Record<AutomationAction, string> = {
  click: '点击',
  input: '输入',
  scroll: '滚动',
  extract: '提取',
  wait: '等待',
}

const ACTION_STYLES: Record<
  AutomationAction,
  { color: string; fill: string; strongFill: string }
> = {
  click: {
    color: '#3b82f6',
    fill: 'rgba(59,130,246,.10)',
    strongFill: 'rgba(59,130,246,.24)',
  },
  input: {
    color: '#10b981',
    fill: 'rgba(16,185,129,.10)',
    strongFill: 'rgba(16,185,129,.24)',
  },
  scroll: {
    color: '#8b5cf6',
    fill: 'rgba(139,92,246,.10)',
    strongFill: 'rgba(139,92,246,.24)',
  },
  extract: {
    color: '#f59e0b',
    fill: 'rgba(245,158,11,.10)',
    strongFill: 'rgba(245,158,11,.24)',
  },
  wait: {
    color: '#6b7280',
    fill: 'rgba(107,114,128,.10)',
    strongFill: 'rgba(107,114,128,.24)',
  },
}

const FONT = 'system-ui,-apple-system,"Segoe UI",sans-serif'
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
const MAX_BOXES = 200
const ROOT_ID = 'mr-preview-layer'

interface PreviewStep {
  index: number
  action: AutomationAction
  selector: string
}

interface Target {
  element: Element
  steps: PreviewStep[]
}

interface BoxEntry {
  element: Element
  node: HTMLDivElement
  target: Target
  color: string
  fill: string
  strongFill: string
}

let activeKey = ''
let previewHref = ''
let root: HTMLDivElement | null = null
let boxes: BoxEntry[] = []
let selected: BoxEntry | null = null
let popover: HTMLDivElement | null = null
let frame = 0
let pollTimer: number | undefined
let observer: MutationObserver | null = null

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  styles: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.style.cssText = styles
  if (text !== undefined) node.textContent = text
  return node
}

function queryAll(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector))
  } catch {
    return []
  }
}

/** 按自动化实际会操作的元素数量选取目标 */
function targetsOf(step: AutomationStep): Element[] {
  const selector = step.selector.trim()
  if (!selector) return []

  const elements = queryAll(selector)
  if (step.action === 'scroll') return elements.slice(0, 1)
  if (step.action === 'extract') return elements
  if (step.action === 'click' || step.action === 'input') {
    return step.all ? elements : elements.slice(0, 1)
  }
  return []
}

function collectTargets(steps: AutomationStep[]) {
  const targets = new Map<Element, Target>()
  let missing = 0

  steps.forEach((step, index) => {
    if (step.action === 'wait') return

    // 无选择器的滚动表示滚动整页，不需要标注；其它动作没有选择器视为未匹配
    if (!step.selector.trim()) {
      if (step.action !== 'scroll') missing += 1
      return
    }

    const elements = targetsOf(step)
    if (!elements.length) {
      missing += 1
      return
    }

    const previewStep: PreviewStep = {
      index: index + 1,
      action: step.action,
      selector: step.selector.trim(),
    }

    for (const element of elements) {
      const existing = targets.get(element)
      if (existing) {
        if (!existing.steps.some((item) => item.index === previewStep.index)) {
          existing.steps.push(previewStep)
        }
      } else {
        targets.set(element, { element, steps: [previewStep] })
      }
    }
  })

  return { targets, missing }
}

function positionPopover(entry: BoxEntry) {
  if (!popover) return
  if (!entry.element.isConnected) {
    popover.style.display = 'none'
    return
  }

  const rect = entry.element.getBoundingClientRect()
  if (
    rect.width < 1 ||
    rect.height < 1 ||
    rect.bottom < 0 ||
    rect.top > window.innerHeight
  ) {
    popover.style.display = 'none'
    return
  }

  popover.style.display = 'block'

  const margin = 8
  const width = popover.offsetWidth
  const height = popover.offsetHeight
  const maxLeft = Math.max(margin, window.innerWidth - width - margin)
  const left = Math.min(Math.max(margin, rect.left), maxLeft)

  let top = rect.bottom + margin
  if (top + height > window.innerHeight - margin) top = rect.top - height - margin
  if (top < margin) top = margin

  popover.style.transform = `translate(${left}px, ${top}px)`
}

function updatePositions() {
  if (!activeKey) return

  // SPA 切页后旧选择器的标注已经没有意义
  if (location.href !== previewHref) {
    clearPreview()
    return
  }

  for (const { element, node } of boxes) {
    if (!element.isConnected) {
      node.style.display = 'none'
      continue
    }

    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) {
      node.style.display = 'none'
      continue
    }

    node.style.display = 'block'
    node.style.transform = `translate(${rect.left}px, ${rect.top}px)`
    node.style.width = `${rect.width}px`
    node.style.height = `${rect.height}px`

    const label = node.firstElementChild as HTMLElement | null
    if (label) label.style.top = rect.top >= 20 ? '-18px' : '0px'
  }

  if (selected) positionPopover(selected)
}

function scheduleUpdate() {
  if (!activeKey || frame) return
  frame = window.requestAnimationFrame(() => {
    frame = 0
    updatePositions()
  })
}

function onDocumentClick(event: MouseEvent) {
  if (!selected || !root) return
  const target = event.target
  if (target instanceof Node && root.contains(target)) return
  deselectBox()
}

function onPreviewKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !selected) return
  event.preventDefault()
  event.stopPropagation()
  deselectBox()
}

function startTracking() {
  window.addEventListener('scroll', scheduleUpdate, true)
  window.addEventListener('resize', scheduleUpdate)
  document.addEventListener('click', onDocumentClick, true)
  document.addEventListener('keydown', onPreviewKeyDown, true)

  observer = new MutationObserver(scheduleUpdate)
  observer.observe(document.documentElement, { childList: true, subtree: true })

  // 兜底处理纯样式变化（动画、展开/收起）导致的位移
  pollTimer = window.setInterval(scheduleUpdate, 500)
}

function deselectBox() {
  if (selected) {
    selected.node.style.outline = ''
    selected.node.style.outlineOffset = ''
    selected.node.style.background = selected.fill
  }
  selected = null
  popover?.remove()
  popover = null
}

function selectBox(entry: BoxEntry) {
  if (selected === entry) {
    deselectBox()
    return
  }

  deselectBox()
  selected = entry
  entry.node.style.outline = `2px solid ${entry.color}`
  entry.node.style.outlineOffset = '2px'
  entry.node.style.background = entry.strongFill
  showPopover(entry)
}

function showPopover(entry: BoxEntry) {
  popover?.remove()

  const box = makeElement(
    'div',
    [
      'all:initial',
      'display:block',
      'position:absolute',
      'left:0',
      'top:0',
      'z-index:2',
      'box-sizing:border-box',
      'min-width:220px',
      'max-width:320px',
      'padding:10px 12px',
      'border-radius:8px',
      'background:#111827',
      'color:#f9fafb',
      `font:12px/1.55 ${FONT}`,
      'box-shadow:0 10px 30px rgba(0,0,0,.35)',
      'pointer-events:auto',
      'cursor:default',
      'visibility:hidden',
    ].join(';'),
  )

  const header = makeElement(
    'div',
    `display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font:700 12px/18px ${FONT};color:#f9fafb`,
  )
  const tag = entry.element.tagName.toLowerCase()
  header.appendChild(makeElement('span', 'all:initial;color:#f9fafb', `元素 <${tag}>`))

  const close = makeElement(
    'button',
    ['all:initial', 'display:block', 'padding:0 4px', 'color:#9ca3af', `font:600 14px/18px ${FONT}`, 'cursor:pointer'].join(
      ';',
    ),
    '×',
  )
  close.type = 'button'
  close.setAttribute('aria-label', '关闭')
  close.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    deselectBox()
  })
  header.appendChild(close)
  box.appendChild(header)

  const snippet = (entry.element.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (snippet) {
    box.appendChild(
      makeElement(
        'div',
        [
          'all:initial',
          'display:block',
          'margin:0 0 8px',
          'color:#9ca3af',
          `font:11px/1.5 ${FONT}`,
          'white-space:nowrap',
          'overflow:hidden',
          'text-overflow:ellipsis',
        ].join(';'),
        snippet.slice(0, 60),
      ),
    )
  }

  for (const step of entry.target.steps) {
    const row = makeElement('div', 'all:initial;display:block;margin-top:6px')
    const title = makeElement(
      'div',
      [
        'all:initial',
        'display:flex',
        'align-items:center',
        'gap:5px',
        'color:#e5e7eb',
        `font:600 11px/16px ${FONT}`,
      ].join(';'),
    )
    const style = ACTION_STYLES[step.action] ?? ACTION_STYLES.click
    title.appendChild(
      makeElement(
        'span',
        `all:initial;display:inline-block;width:6px;height:6px;border-radius:50%;background:${style.color}`,
      ),
    )
    title.appendChild(document.createTextNode(`步骤 ${step.index} · ${ACTION_LABELS[step.action]}`))
    row.appendChild(title)

    if (step.selector) {
      row.appendChild(
        makeElement(
          'code',
          [
            'all:initial',
            'display:block',
            'margin-top:3px',
            'padding:4px 6px',
            'border-radius:4px',
            'background:#1f2937',
            'color:#d1d5db',
            `font:11px/1.5 ${MONO}`,
            'white-space:normal',
            'word-break:break-all',
          ].join(';'),
          step.selector,
        ),
      )
    }

    box.appendChild(row)
  }

  const selectors = Array.from(
    new Set(entry.target.steps.map((step) => step.selector).filter(Boolean)),
  )
  if (selectors.length) {
    const copy = makeElement(
      'button',
      [
        'all:initial',
        'display:inline-block',
        'margin-top:9px',
        'padding:4px 9px',
        'border:1px solid #374151',
        'border-radius:5px',
        'background:#1f2937',
        'color:#e5e7eb',
        `font:600 11px/16px ${FONT}`,
        'cursor:pointer',
      ].join(';'),
      '复制选择器',
    )
    copy.type = 'button'
    copy.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const clipboard = navigator.clipboard
      if (!clipboard) {
        copy.textContent = '无法复制'
        return
      }
      void clipboard
        .writeText(selectors.join('\n'))
        .then(() => {
          copy.textContent = '已复制'
        })
        .catch(() => {
          copy.textContent = '复制失败'
        })
    })
    box.appendChild(copy)
  }

  // 点击浮层本身不要传给页面
  box.addEventListener('click', (event) => event.stopPropagation())

  root?.appendChild(box)
  popover = box
  positionPopover(entry)
  box.style.visibility = 'visible'
}

function createBox(target: Target): BoxEntry {
  const style = ACTION_STYLES[target.steps[0].action] ?? ACTION_STYLES.click

  const node = makeElement(
    'div',
    [
      'all:initial',
      'display:block',
      'position:absolute',
      'left:0',
      'top:0',
      'box-sizing:border-box',
      `border:2px solid ${style.color}`,
      `background:${style.fill}`,
      'border-radius:4px',
      'box-shadow:0 0 0 1px rgba(255,255,255,.4) inset',
      'pointer-events:auto',
      'cursor:pointer',
    ].join(';'),
  )

  const label = makeElement(
    'span',
    [
      'all:initial',
      'display:block',
      'position:absolute',
      'left:-2px',
      `background:${style.color}`,
      'padding:1px 5px',
      'border-radius:3px',
      'color:#fff',
      `font:600 10px/14px ${FONT}`,
      'letter-spacing:.01em',
      'white-space:nowrap',
      'box-shadow:0 1px 4px rgba(0,0,0,.25)',
      'pointer-events:none',
    ].join(';'),
    target.steps.map((step) => `${step.index} · ${ACTION_LABELS[step.action]}`).join('　'),
  )
  node.appendChild(label)

  const entry: BoxEntry = {
    element: target.element,
    node,
    target,
    color: style.color,
    fill: style.fill,
    strongFill: style.strongFill,
  }

  node.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    selectBox(entry)
  })

  node.addEventListener('mouseenter', () => {
    if (selected !== entry) node.style.background = entry.strongFill
  })
  node.addEventListener('mouseleave', () => {
    if (selected !== entry) node.style.background = entry.fill
  })

  return entry
}

function buildMessage(elements: number, missing: number, truncated: number): string {
  const parts: string[] = [
    elements ? `已标注 ${elements} 个元素` : '没有匹配到可操作的元素',
  ]
  if (missing) parts.push(`${missing} 个步骤未匹配`)
  if (truncated) parts.push(`另有 ${truncated} 个元素未显示`)
  return parts.join('，')
}

/**
 * 标注工作流会操作的元素。
 * 同一个 key 再次调用视为取消标注。
 */
export function previewSteps(
  key: string,
  steps: AutomationStep[],
): { active: boolean; matched: number; message: string } {
  if (activeKey && activeKey === key) {
    clearPreview()
    return { active: false, matched: 0, message: '已清除页面标注' }
  }

  clearPreview()
  activeKey = key
  previewHref = location.href

  const { targets, missing } = collectTargets(steps)
  const entries = Array.from(targets.values())
  const shown = entries.slice(0, MAX_BOXES)
  const truncated = entries.length - shown.length

  if (shown.length) {
    root = makeElement(
      'div',
      [
        'all:initial',
        'display:block',
        'position:fixed',
        'inset:0',
        'z-index:2147483645',
        'pointer-events:none',
        'overflow:hidden',
        'contain:layout style',
      ].join(';'),
    )
    root.id = ROOT_ID
    document.documentElement.appendChild(root)

    boxes = shown.map(createBox)
    boxes.forEach(({ node }) => root?.appendChild(node))

    // 角落提示：让「标注后可以点开标注框」这件事一眼可见
    root.appendChild(
      makeElement(
        'div',
        [
          'all:initial',
          'display:block',
          'position:absolute',
          'right:12px',
          'bottom:12px',
          'padding:6px 10px',
          'border-radius:999px',
          'background:rgba(17,24,39,.92)',
          'color:#f9fafb',
          `font:500 11px/16px ${FONT}`,
          'white-space:nowrap',
          'box-shadow:0 4px 14px rgba(0,0,0,.3)',
          'pointer-events:none',
        ].join(';'),
        `已标注 ${shown.length} 处 · 点击标注框查看选择器`,
      ),
    )
    updatePositions()
    startTracking()
  }

  return {
    active: true,
    matched: shown.length,
    message: buildMessage(shown.length, missing, truncated),
  }
}

export function clearPreview() {
  activeKey = ''
  previewHref = ''

  deselectBox()

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
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('keydown', onPreviewKeyDown, true)

  if (root) {
    root.remove()
    root = null
  }
  boxes = []
}

export function isPreviewing() {
  return activeKey !== ''
}
