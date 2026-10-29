import type {
  AutomationLogLevel,
  AutomationStep,
  ExtractResult,
} from '../shared/types'

export interface AutomationHooks {
  log: (level: AutomationLogLevel, message: string) => void
  result: (data: ExtractResult[]) => void
  done: (ok: boolean) => void
}

const ACTION_LABELS: Record<AutomationStep['action'], string> = {
  click: '点击',
  input: '输入',
  scroll: '滚动',
  extract: '提取',
  wait: '等待',
}

let cancelled = false
let running = false

export function isAutomationRunning() {
  return running
}

export function cancelAutomation() {
  cancelled = true
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
}

async function cancellableSleep(ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !cancelled) {
    await sleep(Math.min(100, deadline - Date.now()))
  }
}

const POLL_INTERVAL = 120
const DEFAULT_SELECTOR_TIMEOUT = 8000

function queryAll(selector: string): Element[] {
  if (!selector) throw new Error('选择器为空')
  try {
    return Array.from(document.querySelectorAll(selector))
  } catch {
    throw new Error(`选择器无效：${selector}`)
  }
}

function selectorTimeout(step: AutomationStep): number {
  const value = Number(step.timeout)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SELECTOR_TIMEOUT
}

/**
 * 等待选择器匹配到元素。
 * 路由切换后目标节点通常要等新视图渲染完才出现，立即查询会直接失败；
 * 这里轮询到超时为止，超时由 step.timeout 控制（0 表示只查一次）。
 */
async function waitForElements(
  selector: string,
  timeoutMs: number,
  hooks: AutomationHooks,
): Promise<Element[]> {
  const deadline = Date.now() + timeoutMs
  let announced = false

  for (;;) {
    const elements = queryAll(selector)
    if (elements.length || timeoutMs <= 0 || cancelled) return elements
    if (Date.now() >= deadline) return elements

    if (!announced) {
      hooks.log('info', `等待元素出现：${selector}（最多 ${timeoutMs}ms）`)
      announced = true
    }
    await cancellableSleep(Math.min(POLL_INTERVAL, Math.max(1, deadline - Date.now())))
  }
}

/**
 * 原生 <select> 的 <option> 没有可靠的交互入口：直接 click() 的行为依赖浏览器，
 * 而且很多页面（例如 Jenkins）只监听 select 的 change。
 * 这里手动同步选中状态，再补发 input / change，等价于用户点选了该选项。
 */
function clickOption(option: HTMLOptionElement) {
  const select = option.closest('select')
  const mouse = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: window,
  })

  // 事件被页面拦截时按原生规则取消选中
  const allowed = option.dispatchEvent(mouse)
  if (!allowed || option.disabled) return

  option.selected = true
  if (!select) return

  select.focus()
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function fillElement(element: Element, value: string) {
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
    const checked = /^(true|1|checked|yes|on)$/i.test(value.trim())
    element.focus()
    if (element.checked !== checked) element.click()
    return
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype =
      element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter) setter.call(element, value)
    else element.value = value
    element.focus()
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }

  if (element instanceof HTMLSelectElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    if (setter) setter.call(element, value)
    else element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus()
    element.textContent = value
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }),
    )
    return
  }

  throw new Error(`元素不可输入：<${element.tagName.toLowerCase()}>`)
}

function extractValue(element: Element, attribute: string): string {
  if (attribute) return element.getAttribute(attribute) ?? ''
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return element.value
  }
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

async function executeStep(
  step: AutomationStep,
  index: number,
  results: ExtractResult[],
  hooks: AutomationHooks,
) {
  const selector = step.selector.trim()

  switch (step.action) {
    case 'wait': {
      const parsed = Number.parseInt(step.value, 10)
      const duration = Number.isFinite(parsed) ? Math.max(0, parsed) : 500
      hooks.log('info', `等待 ${duration}ms`)
      await cancellableSleep(duration)
      return
    }

    case 'scroll': {
      if (selector) {
        const timeout = selectorTimeout(step)
        const elements = await waitForElements(selector, timeout, hooks)
        if (!elements.length) {
          if (cancelled) return
          throw new Error(`等待 ${timeout}ms 后仍未找到元素：${selector}`)
        }
        elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' })
        hooks.log('success', `已滚动到 ${selector}`)
      } else {
        const raw = step.value.trim().toLowerCase()
        if (raw === 'top' || raw === 'bottom') {
          window.scrollTo({
            top: raw === 'top' ? 0 : document.body.scrollHeight,
            behavior: 'smooth',
          })
          hooks.log('success', `已滚动到页面${raw === 'top' ? '顶部' : '底部'}`)
        } else {
          const parsed = Number.parseInt(raw, 10)
          const distance = Number.isFinite(parsed) ? parsed : 600
          window.scrollBy({ top: distance, behavior: 'smooth' })
          hooks.log('success', `滚动 ${distance}px`)
        }
      }
      await cancellableSleep(400)
      return
    }

    case 'click': {
      const timeout = selectorTimeout(step)
      const elements = await waitForElements(selector, timeout, hooks)
      if (!elements.length) {
        if (cancelled) return
        throw new Error(`等待 ${timeout}ms 后仍未找到元素：${selector}`)
      }
      const targets = step.all ? elements : [elements[0]]
      for (const element of targets) {
        if (cancelled) return
        element.scrollIntoView({ block: 'center' })
        if (element instanceof HTMLOptionElement) {
          clickOption(element)
        } else if (element instanceof HTMLElement) {
          element.click()
        } else {
          // SVG 等非 HTMLElement 节点没有 click()
          element.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
          )
        }
        if (step.all) await cancellableSleep(120)
      }
      hooks.log('success', `已点击 ${targets.length} 个元素`)
      return
    }

    case 'input': {
      const timeout = selectorTimeout(step)
      const elements = await waitForElements(selector, timeout, hooks)
      if (!elements.length) {
        if (cancelled) return
        throw new Error(`等待 ${timeout}ms 后仍未找到元素：${selector}`)
      }
      const targets = step.all ? elements : [elements[0]]
      for (const element of targets) {
        if (cancelled) return
        fillElement(element, step.value)
      }
      hooks.log('success', `已向 ${targets.length} 个元素填入内容`)
      return
    }

    case 'extract': {
      const elements = await waitForElements(selector, selectorTimeout(step), hooks)
      if (cancelled) return
      const attribute = step.value.trim().replace(/^@/, '')
      const values = elements.map((element) => extractValue(element, attribute))
      results.push({ stepIndex: index, selector, values })
      hooks.log(
        values.length ? 'success' : 'warn',
        values.length ? `提取到 ${values.length} 条数据` : `未匹配到元素：${selector}`,
      )
      return
    }
  }
}

export async function runAutomation(steps: AutomationStep[], hooks: AutomationHooks) {
  if (running) {
    hooks.log('error', '已有流程正在执行')
    hooks.done(false)
    return
  }

  running = true
  cancelled = false
  const results: ExtractResult[] = []

  try {
    for (let index = 0; index < steps.length; index += 1) {
      if (cancelled) {
        hooks.log('warn', '已停止执行')
        hooks.done(false)
        return
      }

      const step = steps[index]
      hooks.log('info', `步骤 ${index + 1} · ${ACTION_LABELS[step.action]}`)

      try {
        await executeStep(step, index, results, hooks)
      } catch (error) {
        hooks.log('error', `步骤 ${index + 1} 失败：${(error as Error).message}`)
        hooks.done(false)
        return
      }

      await sleep(80)
    }

    if (cancelled) {
      hooks.log('warn', '已停止执行')
      hooks.done(false)
      return
    }

    hooks.result(results)
    hooks.log('success', `执行完成，共 ${steps.length} 个步骤`)
    hooks.done(true)
  } finally {
    running = false
    cancelled = false
  }
}
