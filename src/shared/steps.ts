import type { AutomationAction, AutomationStep } from './types'

export const STEP_ACTIONS: AutomationAction[] = ['click', 'input', 'scroll', 'extract', 'wait']

/**
 * 把外部来源（导入的 JSON、模型输出）的步骤对象规整成 AutomationStep。
 * 返回 null 表示动作不合法，交给调用方决定报错文案。
 */
export function normalizeStep(raw: unknown): AutomationStep | null {
  if (!raw || typeof raw !== 'object') return null

  const record = raw as Record<string, unknown>
  const action = record.action
  if (typeof action !== 'string' || !STEP_ACTIONS.includes(action as AutomationAction)) {
    return null
  }

  const value =
    typeof record.value === 'string'
      ? record.value
      : typeof record.value === 'number' || typeof record.value === 'boolean'
        ? String(record.value)
        : ''

  const rawFrame = record.frameId ?? record.frame
  const frameId =
    typeof rawFrame === 'number' && Number.isInteger(rawFrame) && rawFrame >= 0
      ? rawFrame
      : typeof rawFrame === 'string' && /^\d+$/.test(rawFrame.trim())
        ? Number(rawFrame.trim())
        : undefined

  return {
    id: crypto.randomUUID(),
    action: action as AutomationAction,
    selector: typeof record.selector === 'string' ? record.selector : '',
    value,
    ...(record.all === true ? { all: true } : {}),
    ...(frameId != null ? { frameId } : {}),
  }
}

/**
 * 整条流程在哪个 frame 中执行。
 * 只有带选择器的步骤决定 frame；wait 和无选择器的 scroll 跟随流程所在 frame。
 * 返回 null 表示步骤分布在多个 frame 中，当前执行器无法跨 frame 执行。
 */
export function resolveStepsFrame(steps: AutomationStep[]): number | null {
  const frames = new Set<number>()

  for (const step of steps) {
    if (step.action === 'wait' || !step.selector.trim()) continue
    frames.add(step.frameId ?? 0)
  }

  if (!frames.size) return 0
  if (frames.size === 1) return frames.values().next().value ?? 0
  return null
}
