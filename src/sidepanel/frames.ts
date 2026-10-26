import type {
  FromContentMessage,
  PageContext,
  PageElementSummary,
  PageFrameSummary,
  ToContentMessage,
} from '../shared/types'

export interface FrameContextEntry {
  frameId: number
  url: string
  context: PageContext
}

export interface FrameProbeEntry {
  frameId: number
  matched: number
  total: number
}

const MAX_MERGED_INTERACTIVE = 120
const MAX_MERGED_CONTENT = 80
const MAX_MERGED_CHARS = 18000

/**
 * 内容脚本分布在多个 frame 中，tabs.sendMessage 的回调只能拿到其中一个响应，
 * 因此这里监听 runtime 消息，按 sender.frameId 汇总所有 frame 的回复。
 */
function collectReplies<T>(
  tabId: number,
  message: ToContentMessage,
  read: (reply: FromContentMessage, sender: chrome.runtime.MessageSender) => T | null,
  timeoutMs: number,
): Promise<T[]> {
  return new Promise((resolve) => {
    const results: T[] = []
    let done = false
    let timer = 0

    const finish = () => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      chrome.runtime.onMessage.removeListener(listener)
      resolve(results)
    }

    const listener = (reply: FromContentMessage, sender: chrome.runtime.MessageSender) => {
      if (sender.tab?.id !== tabId) return
      const value = read(reply, sender)
      if (value != null) results.push(value)
    }

    chrome.runtime.onMessage.addListener(listener)
    timer = window.setTimeout(finish, timeoutMs)

    try {
      chrome.tabs.sendMessage(tabId, message, () => {
        // 广播时部分 frame 可能不可达，回复由 runtime 消息汇总
        void chrome.runtime.lastError
      })
    } catch {
      finish()
    }
  })
}

/** 采集当前标签页所有 frame 的元素摘要（顶层 + iframe） */
export async function collectFrameContexts(
  tabId: number,
  timeoutMs = 450,
): Promise<FrameContextEntry[]> {
  const requestId = crypto.randomUUID()

  const entries = await collectReplies<FrameContextEntry>(
    tabId,
    { type: 'COLLECT_PAGE_CONTEXT', requestId },
    (reply, sender) => {
      if (reply.type !== 'FRAME_CONTEXT' || reply.requestId !== requestId) return null
      const frameId = sender.frameId ?? 0
      return {
        frameId,
        url: reply.context.url || sender.url || '',
        context: reply.context,
      }
    },
    timeoutMs,
  )

  // 同一 frame 理论上只回一次，按 frameId 去重，保留先到的结果
  const unique = new Map<number, FrameContextEntry>()
  for (const entry of entries) {
    if (!unique.has(entry.frameId)) unique.set(entry.frameId, entry)
  }
  return Array.from(unique.values())
}

function tagElements(
  elements: PageElementSummary[],
  frameId: number,
  budget: { chars: number },
  limit: number,
  output: PageElementSummary[],
): boolean {
  for (const element of elements) {
    if (output.length >= limit || budget.chars <= 0) return true
    const tagged: PageElementSummary = { ...element, frameId }
    const cost = JSON.stringify(tagged).length + 1
    if (cost > budget.chars) return true
    budget.chars -= cost
    output.push(tagged)
  }
  return false
}

/** 把各 frame 的上下文合并成一份给模型看的清单，并标记元素来源 frame */
export function mergeFrameContexts(entries: FrameContextEntry[]): PageContext {
  const sorted = [...entries].sort((a, b) => a.frameId - b.frameId)
  const top = sorted.find((entry) => entry.frameId === 0) ?? sorted[0]

  const frames: PageFrameSummary[] = sorted.map((entry) => ({
    frameId: entry.frameId,
    url: entry.context.url || entry.url,
    title: entry.context.title,
  }))

  const elements: PageElementSummary[] = []
  const content: PageElementSummary[] = []
  const budget = { chars: MAX_MERGED_CHARS }
  let totalCandidates = 0
  let truncated = false

  for (const entry of sorted) {
    totalCandidates += entry.context.totalCandidates
    if (entry.context.truncated) truncated = true
    if (tagElements(entry.context.elements, entry.frameId, budget, MAX_MERGED_INTERACTIVE, elements)) {
      truncated = true
    }
    if (tagElements(entry.context.content, entry.frameId, budget, MAX_MERGED_CONTENT, content)) {
      truncated = true
    }
  }

  return {
    url: top?.context.url ?? '',
    title: top?.context.title ?? '',
    headings: top?.context.headings ?? [],
    elements,
    content,
    totalCandidates,
    truncated,
    frames,
  }
}

/**
 * 探测每个 frame 能匹配多少个选择器。
 * 用于页面刷新后 frameId 失效时，重新找到步骤所在的 frame。
 */
export function probeFrames(
  tabId: number,
  selectors: string[],
  timeoutMs = 350,
): Promise<FrameProbeEntry[]> {
  const cleaned = Array.from(new Set(selectors.filter((selector) => selector.trim())))
  if (!cleaned.length) return Promise.resolve([])

  const requestId = crypto.randomUUID()

  return collectReplies<FrameProbeEntry>(
    tabId,
    { type: 'PROBE_FRAME', requestId, selectors: cleaned },
    (reply, sender) => {
      if (reply.type !== 'FRAME_PROBE' || reply.requestId !== requestId) return null
      return {
        frameId: sender.frameId ?? 0,
        matched: reply.matched,
        total: reply.total,
      }
    },
    timeoutMs,
  ).then((entries) => {
    const unique = new Map<number, FrameProbeEntry>()
    for (const entry of entries) {
      if (!unique.has(entry.frameId)) unique.set(entry.frameId, entry)
    }
    return Array.from(unique.values())
  })
}

/** 选出匹配选择器最多的 frame；没有任何匹配时返回 null */
export function bestFrameFromProbe(entries: FrameProbeEntry[]): number | null {
  let best: FrameProbeEntry | null = null
  for (const entry of entries) {
    if (entry.matched < 1) continue
    if (
      !best ||
      entry.matched > best.matched ||
      (entry.matched === best.matched && entry.frameId < best.frameId)
    ) {
      best = entry
    }
  }
  return best ? best.frameId : null
}
