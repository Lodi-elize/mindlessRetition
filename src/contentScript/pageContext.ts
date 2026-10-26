import type { PageContext, PageElementSummary } from '../shared/types'
import { buildSelector } from './picker'

const MAX_INTERACTIVE = 80
const MAX_CONTENT = 50
const MAX_SCAN = 2000
const MAX_TEXT = 80
const MAX_CONTENT_TEXT = 120
const MAX_SELECTOR = 300
const MAX_SERIALIZED = 14000
const MAX_OPTIONS = 20

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  'summary',
].join(',')

const CONTENT_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'h4',
  'p',
  'li',
  'td',
  'th',
  'span',
  'strong',
  'em',
  'b',
  'small',
  'code',
  'label',
  'time',
].join(',')

const EXTENSION_ROOTS =
  '#mr-picker-overlay,#mr-picker-banner,#mr-picker-hint,#mr-preview-layer,#mr-element-mark-layer,#mr-preview-pill'

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function isExtensionNode(element: Element): boolean {
  // 只认扩展自己的 overlay 容器，避免误伤 mr-2、mr-4 这类工具类
  if (element.id.startsWith('mr-')) return true
  return Boolean(element.closest(EXTENSION_ROOTS))
}

const EDITABLE_REGION =
  '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]'

/** 富文本编辑器里可能是用户正在输入的内容，不放进摘要 */
function isInEditableRegion(element: Element): boolean {
  return (
    (element instanceof HTMLElement && element.isContentEditable) ||
    Boolean(element.closest(EDITABLE_REGION))
  )
}

function isVisible(element: Element): boolean {
  const candidate = element as Element & {
    checkVisibility?: (options?: {
      checkOpacity?: boolean
      checkVisibilityCSS?: boolean
    }) => boolean
  }
  if (typeof candidate.checkVisibility === 'function') {
    try {
      return candidate.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    } catch {
      /* 旧实现忽略参数，回退到几何判断 */
    }
  }
  return element.getClientRects().length > 0
}

function isUsable(element: Element): boolean {
  // 执行器使用 document.querySelectorAll，Shadow DOM 里的元素无法定位
  if (element.getRootNode() !== document) return false
  if (isExtensionNode(element)) return false
  return isVisible(element)
}

function hasDirectText(element: Element): boolean {
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && cleanText(node.textContent).length > 0) {
      return true
    }
  }
  return false
}

function queryCandidates(selector: string): { nodes: Element[]; capped: boolean } {
  try {
    const nodes = Array.from(document.querySelectorAll(selector))
    return { nodes: nodes.slice(0, MAX_SCAN), capped: nodes.length > MAX_SCAN }
  } catch {
    return { nodes: [], capped: false }
  }
}

interface SummaryOptions {
  /** 内容元素要求直接文本，且文本长度受限 */
  content?: boolean
}

function summarize(element: Element, options: SummaryOptions = {}): PageElementSummary | null {
  if (!isUsable(element)) return null

  const selector = buildSelector(element)
  if (!selector || selector.length > MAX_SELECTOR) return null

  let matchCount = 0
  try {
    matchCount = document.querySelectorAll(selector).length
  } catch {
    return null
  }
  if (!matchCount) return null

  const text = cleanText(element.textContent)
  if (options.content) {
    if (!hasDirectText(element)) return null
    if (text.length < 1 || text.length > MAX_CONTENT_TEXT) return null
  }

  const summary: PageElementSummary = {
    selector,
    tag: element.tagName.toLowerCase(),
    matchCount,
  }

  if (text && !isInEditableRegion(element)) summary.text = text.slice(0, MAX_TEXT)

  const name = cleanText(
    element.getAttribute('aria-label') ||
      element.getAttribute('placeholder') ||
      element.getAttribute('alt') ||
      element.getAttribute('title') ||
      element.getAttribute('name'),
  )
  if (name) summary.name = name.slice(0, MAX_TEXT)

  if (element instanceof HTMLInputElement) {
    summary.type = element.type
  } else {
    const type = element.getAttribute('type')
    if (type) summary.type = type
  }

  if (element instanceof HTMLSelectElement) {
    summary.options = Array.from(element.options)
      .slice(0, MAX_OPTIONS)
      .map((option) => ({
        value: option.value,
        text: cleanText(option.text).slice(0, 60),
      }))
  }

  return summary
}

function collectHeadings(): string[] {
  const headings: string[] = []
  const seen = new Set<string>()

  try {
    for (const element of Array.from(document.querySelectorAll('h1, h2, h3'))) {
      if (headings.length >= 8) break
      if (!isUsable(element)) continue
      const text = cleanText(element.textContent).slice(0, 60)
      if (!text || seen.has(text)) continue
      seen.add(text)
      headings.push(text)
    }
  } catch {
    /* 忽略异常页面结构 */
  }

  return headings
}

/**
 * 收集当前页面可供 AI 生成选择器的元素摘要。
 * 不读取输入框的 value，只使用占位符、名称等属性。
 */
export function collectPageContext(): PageContext {
  const interactive = queryCandidates(INTERACTIVE_SELECTOR)
  const contentNodes = queryCandidates(CONTENT_SELECTOR)

  let truncated = interactive.capped || contentNodes.capped
  let budget = MAX_SERIALIZED

  const elements: PageElementSummary[] = []
  const content: PageElementSummary[] = []
  const usedSelectors = new Set<string>()

  for (const element of interactive.nodes) {
    if (elements.length >= MAX_INTERACTIVE || budget <= 0) {
      truncated = true
      break
    }

    const summary = summarize(element)
    if (!summary || usedSelectors.has(summary.selector)) continue

    const cost = JSON.stringify(summary).length + 1
    if (cost > budget) {
      truncated = true
      break
    }

    budget -= cost
    usedSelectors.add(summary.selector)
    elements.push(summary)
  }

  for (const element of contentNodes.nodes) {
    if (content.length >= MAX_CONTENT || budget <= 0) {
      truncated = true
      break
    }

    // 可交互元素内部的内容交给交互清单描述，避免重复
    if (element.closest(INTERACTIVE_SELECTOR)) continue

    const summary = summarize(element, { content: true })
    if (!summary || usedSelectors.has(summary.selector)) continue

    const cost = JSON.stringify(summary).length + 1
    if (cost > budget) {
      truncated = true
      break
    }

    budget -= cost
    usedSelectors.add(summary.selector)
    content.push(summary)
  }

  return {
    url: location.href,
    title: cleanText(document.title).slice(0, 120),
    headings: collectHeadings(),
    elements,
    content,
    totalCandidates: interactive.nodes.length + contentNodes.nodes.length,
    truncated,
  }
}
