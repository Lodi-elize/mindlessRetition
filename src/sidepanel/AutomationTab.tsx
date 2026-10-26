import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'

import {
  STORAGE_AUTOMATION,
  STORAGE_WORKFLOWS,
  type AutomationAction,
  type AutomationLogLevel,
  type AutomationStep,
  type ContentResponse,
  type ExtractResult,
  type FromContentMessage,
  type Workflow,
} from '../shared/types'
import { resolveStepsFrame } from '../shared/steps'
import { ActionSelect } from './ActionSelect'
import { AiWorkflowCard } from './AiWorkflowCard'
import { bestFrameFromProbe, probeFrames } from './frames'
import { getStorage, sendToTab, setStorage } from './messaging'
import { usePickerKeys } from './usePickerKeys'
import { WorkflowPanel } from './WorkflowPanel'

interface Props {
  tabId: number | null
  pageUrl: string
  connected: boolean
}

interface LogEntry {
  level: AutomationLogLevel
  message: string
}

const ACTION_OPTIONS: { value: AutomationAction; label: string }[] = [
  { value: 'click', label: '点击' },
  { value: 'input', label: '输入' },
  { value: 'scroll', label: '滚动' },
  { value: 'extract', label: '提取' },
  { value: 'wait', label: '等待' },
]

function valueLabel(action: AutomationAction): string {
  switch (action) {
    case 'input':
      return '输入内容'
    case 'scroll':
      return '滚动距离'
    case 'extract':
      return '属性（可选）'
    case 'wait':
      return '等待毫秒数'
    default:
      return '值'
  }
}

function valuePlaceholder(action: AutomationAction): string {
  switch (action) {
    case 'input':
      return '要填入的文本'
    case 'scroll':
      return '默认 600px，也可填 top / bottom'
    case 'extract':
      return '留空取文本，如 @href'
    case 'wait':
      return '默认 500ms'
    default:
      return ''
  }
}

function validate(steps: AutomationStep[]): string | null {
  if (!steps.length) return '请先添加至少一个步骤'

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step.action === 'wait') {
      if (step.value.trim() && Number.isNaN(Number.parseInt(step.value, 10))) {
        return `步骤 ${index + 1}：等待时间需为毫秒数`
      }
      continue
    }
    if (step.action !== 'scroll' && !step.selector.trim()) {
      return `步骤 ${index + 1}：请填写选择器`
    }
    if (step.action === 'input' && !step.value) {
      return `步骤 ${index + 1}：请输入要填入的内容`
    }
  }

  return null
}

function frameConnectionMessage(message: string): string {
  if (/Receiving end|Could not establish|message port closed/i.test(message)) {
    return '目标 iframe 已刷新或不可达，请重新点选相关步骤后再运行。'
  }
  return message
}

/** 比较步骤内容是否变化，忽略 id 等不影响执行的字段 */
function stepSignature(step: AutomationStep): string {
  return JSON.stringify([
    step.action,
    step.selector,
    step.value,
    step.all ? 1 : 0,
    step.frameId ?? 0,
  ])
}

function stepsSignature(list: AutomationStep[]): string {
  return list.map(stepSignature).join('|')
}

interface EditingWorkflow {
  id: string
  name: string
  /** 加载时的步骤快照，用于判断是否有未保存修改 */
  originalSteps: AutomationStep[]
}

export function AutomationTab({ tabId, pageUrl, connected }: Props) {
  const [steps, setSteps] = useState<AutomationStep[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [results, setResults] = useState<ExtractResult[]>([])
  const [pickingStepId, setPickingStepId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [copied, setCopied] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null)
  const [editingWorkflow, setEditingWorkflow] = useState<EditingWorkflow | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editFeedback, setEditFeedback] = useState<{
    kind: 'success' | 'error' | 'info'
    text: string
  } | null>(null)

  const runIdRef = useRef<string | null>(null)
  const pickRequestRef = useRef<{ requestId: string; stepId: string } | null>(null)
  const logEndRef = useRef<HTMLDivElement | null>(null)
  const stepsRef = useRef<AutomationStep[]>(steps)
  /** dragstart / dragover 之间同步取用，避免依赖 React 状态刷新时机 */
  const dragIdRef = useRef<string | null>(null)

  useEffect(() => {
    stepsRef.current = steps
  }, [steps])

  useEffect(() => {
    void (async () => {
      const data = await getStorage<Record<string, AutomationStep[] | undefined>>(
        STORAGE_AUTOMATION,
      )
      // 若用户在读取完成前已经添加了步骤，按 id 合并而不是直接覆盖
      setSteps((previous) => {
        const stored = data[STORAGE_AUTOMATION] ?? []
        if (!previous.length) return stored
        const existing = new Set(previous.map((step) => step.id))
        return [...stored.filter((step) => !existing.has(step.id)), ...previous]
      })
      setHydrated(true)
    })()
  }, [])

  useEffect(() => {
    if (!hydrated) return
    void setStorage({ [STORAGE_AUTOMATION]: steps }).catch(() => undefined)
  }, [steps, hydrated])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [logs])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  // 工作流被重命名 / 删除时同步编辑栏，避免继续往已删除的工作流写数据
  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local' || !changes[STORAGE_WORKFLOWS]) return
      const list = changes[STORAGE_WORKFLOWS].newValue

      setEditingWorkflow((current) => {
        if (!current) return current
        const found = Array.isArray(list)
          ? (list as Workflow[]).find((workflow) => workflow.id === current.id)
          : undefined
        if (!found) return null
        return found.name === current.name ? current : { ...current, name: found.name }
      })
    }

    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }, [])

  useEffect(() => {
    if (!editFeedback) return
    const timer = window.setTimeout(() => setEditFeedback(null), 3200)
    return () => window.clearTimeout(timer)
  }, [editFeedback])

  // 切换页面 / 标签页时，停止旧页面的流程，并清空与新页面无关的日志和结果
  const lastTargetRef = useRef<{ tabId: number | null; pageUrl: string } | null>(null)
  useEffect(() => {
    const previous = lastTargetRef.current
    if (previous?.tabId != null && (previous.tabId !== tabId || previous.pageUrl !== pageUrl)) {
      void sendToTab(previous.tabId, { type: 'CANCEL_AUTOMATION' }).catch(() => undefined)
      void sendToTab(previous.tabId, { type: 'CANCEL_PICK' }).catch(() => undefined)
      void sendToTab(previous.tabId, { type: 'CLEAR_PREVIEW' }).catch(() => undefined)
    }
    lastTargetRef.current = { tabId, pageUrl }

    setRunning(false)
    setPickingStepId(null)
    setLogs([])
    setResults([])
    setError('')
    setNotice('')
    runIdRef.current = null
    pickRequestRef.current = null
  }, [pageUrl, tabId])

  // 页面刷新后内容脚本重新连接，旧流程已经随旧脚本一起消失
  const previousConnectedRef = useRef(connected)
  useEffect(() => {
    if (!previousConnectedRef.current && connected) {
      setRunning(false)
      setPickingStepId(null)
      runIdRef.current = null
      pickRequestRef.current = null
    }
    previousConnectedRef.current = connected
  }, [connected])

  // 侧边栏关闭后重新打开时，接上仍在页面里执行的流程（至少可以停止它）
  useEffect(() => {
    if (tabId == null || !hydrated) return
    let alive = true
    const frameId = resolveStepsFrame(stepsRef.current) ?? 0
    void sendToTab<ContentResponse>(tabId, { type: 'GET_AUTOMATION_STATUS' }, frameId)
      .then((response) => {
        if (!alive || !response?.running) return
        setRunning(true)
        setNotice('检测到该页面已有流程正在执行，可点击「停止」结束。')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [tabId, pageUrl, hydrated])

  // 组件卸载或切换标签页时，确保页面里不会留下无人控制的流程 / 点选器。
  // armed 用于跳过 React StrictMode 开发模式下的“挂载后立刻卸载并重挂载”。
  useEffect(() => {
    let armed = false
    const timer = window.setTimeout(() => {
      armed = true
    }, 0)

    return () => {
      window.clearTimeout(timer)
      if (!armed || tabId == null) return
      void sendToTab(tabId, { type: 'CANCEL_AUTOMATION' }).catch(() => undefined)
      void sendToTab(tabId, { type: 'CANCEL_PICK' }).catch(() => undefined)
      void sendToTab(tabId, { type: 'CLEAR_PREVIEW' }).catch(() => undefined)
    }
  }, [tabId])

  useEffect(() => {
    const listener = (message: FromContentMessage, sender: chrome.runtime.MessageSender) => {
      if (tabId != null && sender.tab?.id !== tabId) return

      // runIdRef 为 null 表示当前面板没有主动发起流程（例如重开面板后接管旧流程），
      // 此时也接收消息，才能看到日志并感知结束
      const belongsToRun =
        'runId' in message
          ? runIdRef.current == null || message.runId === runIdRef.current
          : true

      if (message.type === 'AUTOMATION_LOG') {
        if (!belongsToRun) return
        setLogs((previous) => [
          ...previous,
          { level: message.level, message: message.message },
        ])
      } else if (message.type === 'AUTOMATION_RESULT') {
        if (!belongsToRun) return
        setResults(message.data)
      } else if (message.type === 'AUTOMATION_DONE') {
        if (!belongsToRun) return
        setRunning(false)
        setNotice('')
        runIdRef.current = null
      } else if (message.type === 'PICKED') {
        const request = pickRequestRef.current
        if (!request || request.requestId !== message.requestId) return
        const frameId = sender.frameId ?? 0
        setSteps((previous) =>
          previous.map((step) =>
            step.id === request.stepId
              ? { ...step, selector: message.selector, frameId }
              : step,
          ),
        )
        setPickingStepId(null)
        pickRequestRef.current = null
        // 点选是从所有 frame 同时开始的，选中后结束其它 frame 的点选态
        if (tabId != null) {
          void sendToTab(tabId, { type: 'CANCEL_PICK' }).catch(() => undefined)
        }
      } else if (message.type === 'PICK_CANCELED') {
        if (pickRequestRef.current?.requestId !== message.requestId) return
        setPickingStepId(null)
        pickRequestRef.current = null
      }
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [tabId])

  const cancelPicking = useCallback(() => {
    setPickingStepId(null)
    pickRequestRef.current = null
  }, [])

  // 点选时焦点通常还在侧边栏，方向键 / Enter / Esc 由 hook 转发给页面
  usePickerKeys(pickingStepId != null, tabId, cancelPicking)

  const canRun = connected && tabId != null && steps.length > 0 && pickingStepId == null

  const actionSummary = useMemo(() => {
    if (!steps.length) return '添加步骤后可运行'
    return `将执行 ${steps.length} 个步骤`
  }, [steps.length])

  const editingDirty = useMemo(() => {
    if (!editingWorkflow) return false
    return stepsSignature(steps) !== stepsSignature(editingWorkflow.originalSteps)
  }, [steps, editingWorkflow])

  const updateStep = (id: string, patch: Partial<AutomationStep>) => {
    setSteps((previous) =>
      previous.map((step) => (step.id === id ? { ...step, ...patch } : step)),
    )
  }

  const addStep = () => {
    setSteps((previous) => [
      ...previous,
      { id: crypto.randomUUID(), action: 'click', selector: '', value: '', all: false },
    ])
  }

  const removeStep = (id: string) => {
    setSteps((previous) => previous.filter((step) => step.id !== id))
  }

  const moveStep = (index: number, direction: -1 | 1) => {
    setSteps((previous) => {
      const next = [...previous]
      const target = index + direction
      if (target < 0 || target >= next.length) return previous
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  /** 拖拽排序：把被拖动的步骤插到目标步骤之前 / 之后 */
  const reorderStep = (draggedId: string, targetId: string, after: boolean) => {
    if (draggedId === targetId) return
    setSteps((previous) => {
      const from = previous.findIndex((step) => step.id === draggedId)
      if (from < 0) return previous

      const next = [...previous]
      const [moved] = next.splice(from, 1)
      const targetIndex = next.findIndex((step) => step.id === targetId)
      if (targetIndex < 0) return previous

      next.splice(after ? targetIndex + 1 : targetIndex, 0, moved)
      return next
    })
  }

  const endDrag = () => {
    dragIdRef.current = null
    setDraggingId(null)
    setDropTarget(null)
  }

  const startDrag = (event: DragEvent<HTMLElement>, stepId: string) => {
    dragIdRef.current = stepId
    setDraggingId(stepId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', stepId)

    // 用整张步骤卡作为拖拽预览，而不是只有手柄
    const card = event.currentTarget.closest('.mr-step')
    if (card instanceof HTMLElement) event.dataTransfer.setDragImage(card, 16, 16)
  }

  const hoverStep = (event: DragEvent<HTMLLIElement>, targetId: string) => {
    const dragged = dragIdRef.current
    if (!dragged || dragged === targetId) {
      setDropTarget((current) => (current ? null : current))
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientY > rect.top + rect.height / 2
    setDropTarget((current) =>
      current?.id === targetId && current.after === after ? current : { id: targetId, after },
    )
  }

  const dropOnStep = (event: DragEvent<HTMLLIElement>, targetId: string) => {
    const dragged = dragIdRef.current
    if (!dragged) return

    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    reorderStep(dragged, targetId, event.clientY > rect.top + rect.height / 2)
    endDrag()
  }

  const clearSteps = () => {
    if (!window.confirm('清空全部步骤？')) return
    setSteps([])
  }

  const pick = async (stepId: string) => {
    if (tabId == null || !connected) return

    if (pickingStepId === stepId) {
      try {
        await sendToTab(tabId, { type: 'CANCEL_PICK' })
      } catch {
        /* 页面已不可达 */
      }
      setPickingStepId(null)
      pickRequestRef.current = null
      return
    }

    const requestId = crypto.randomUUID()
    pickRequestRef.current = { requestId, stepId }
    setError('')
    try {
      await sendToTab(tabId, { type: 'START_PICK', requestId })
      setPickingStepId(stepId)
    } catch (sendError) {
      pickRequestRef.current = null
      setPickingStepId(null)
      setError((sendError as Error).message)
    }
  }

  /**
   * 页面刷新后 iframe 的 frameId 可能失效。
   * 让每个 frame 检查自己的文档里能匹配多少步骤选择器，挑选最匹配的 frame。
   */
  const recoverFrameId = async (list: AutomationStep[]): Promise<number | null> => {
    if (tabId == null) return null
    const selectors = Array.from(
      new Set(
        list
          .filter((step) => step.action !== 'wait' && step.selector.trim())
          .map((step) => step.selector.trim()),
      ),
    )
    if (!selectors.length) return null

    const probes = await probeFrames(tabId, selectors)
    return bestFrameFromProbe(probes)
  }

  const runSteps = async (list: AutomationStep[], label?: string) => {
    if (tabId == null) return

    const problem = validate(list)
    if (problem) {
      setError(problem)
      return
    }

    const frameId = resolveStepsFrame(list)
    if (frameId == null) {
      setError('步骤分布在多个 iframe 中，当前版本暂不支持跨 frame 执行。请只保留同一个功能页内的步骤。')
      return
    }

    const runId = crypto.randomUUID()
    runIdRef.current = runId
    setError('')
    setNotice(label ? `正在运行工作流「${label}」…` : '')
    setLogs([])
    setResults([])
    setRunning(true)

    try {
      let targetFrame = frameId
      let response: ContentResponse | undefined

      try {
        response = await sendToTab<ContentResponse>(
          tabId,
          { type: 'RUN_AUTOMATION', runId, steps: list },
          targetFrame,
        )
      } catch (sendError) {
        // frameId 失效时重新探测；同一目标不再重试
        const recovered = await recoverFrameId(list)
        if (recovered == null || recovered === targetFrame) throw sendError
        targetFrame = recovered
        response = await sendToTab<ContentResponse>(
          tabId,
          { type: 'RUN_AUTOMATION', runId, steps: list },
          targetFrame,
        )
      }

      if (!response?.ok) {
        setError(response?.message || '无法启动流程')
        runIdRef.current = null
        // 若页面里其实已有流程在跑，保留运行态，让「停止」按钮可用
        try {
          const status = await sendToTab<ContentResponse>(
            tabId,
            { type: 'GET_AUTOMATION_STATUS' },
            targetFrame,
          )
          setRunning(Boolean(status?.running))
        } catch {
          setRunning(false)
        }
      }
    } catch (sendError) {
      runIdRef.current = null
      setRunning(false)
      setError(frameConnectionMessage((sendError as Error).message))
    }
  }

  const applyWorkflow = (list: AutomationStep[]) => {
    setSteps(list)
    setLogs([])
    setResults([])
    setError('')
    setNotice('')
    runIdRef.current = null
  }

  /** 从工作流列表加载到编辑器，修改后可以写回同一个工作流 */
  const loadWorkflowForEdit = (list: AutomationStep[], workflow: Workflow) => {
    applyWorkflow(list)
    setEditingWorkflow({
      id: workflow.id,
      name: workflow.name,
      originalSteps: list.map((step) => ({ ...step })),
    })
    setEditFeedback(null)

    window.requestAnimationFrame(() => {
      document.getElementById('mr-steps-section')?.scrollIntoView({ block: 'start' })
    })
  }

  const saveEditingWorkflow = async () => {
    if (!editingWorkflow || savingEdit) return
    if (!steps.length) {
      setEditFeedback({ kind: 'error', text: '工作流至少需要一个步骤。' })
      return
    }

    setSavingEdit(true)
    try {
      const data = await getStorage<Record<string, Workflow[] | undefined>>(STORAGE_WORKFLOWS)
      const list = Array.isArray(data[STORAGE_WORKFLOWS]) ? data[STORAGE_WORKFLOWS] : []
      const current = list.find((workflow) => workflow.id === editingWorkflow.id)

      if (!current) {
        setEditingWorkflow(null)
        setEditFeedback({
          kind: 'error',
          text: `工作流「${editingWorkflow.name}」已被删除，修改未保存。`,
        })
        return
      }

      const nextSteps = steps.map((step) => ({ ...step }))
      const now = Date.now()
      await setStorage({
        [STORAGE_WORKFLOWS]: list.map((workflow) =>
          workflow.id === editingWorkflow.id
            ? { ...workflow, steps: nextSteps, updatedAt: now }
            : workflow,
        ),
      })

      setEditingWorkflow((previous) =>
        previous ? { ...previous, name: current.name, originalSteps: nextSteps } : previous,
      )
      setEditFeedback({ kind: 'success', text: `已保存「${current.name}」的修改` })
    } catch (error) {
      setEditFeedback({ kind: 'error', text: `保存失败：${(error as Error).message}` })
    } finally {
      setSavingEdit(false)
    }
  }

  const exitEditing = () => {
    if (editingDirty && !window.confirm('有未保存的修改，退出后不会写回工作流。继续？')) return
    setEditingWorkflow(null)
    setEditFeedback(null)
  }

  const previewWorkflowSteps = async (
    list: AutomationStep[],
    key: string,
  ): Promise<ContentResponse> => {
    if (tabId == null) return { ok: false, message: '没有可用的活动标签页' }

    const frameId = resolveStepsFrame(list)
    if (frameId == null) {
      return { ok: false, message: '步骤分布在多个 iframe 中，暂不支持混合预览。' }
    }

    try {
      const response = await sendToTab<ContentResponse>(
        tabId,
        { type: 'PREVIEW_STEPS', key, steps: list },
        frameId,
      )
      return response ?? { ok: false, message: '内容脚本无响应' }
    } catch (error) {
      // frameId 失效时重新定位一次
      const recovered = await recoverFrameId(list)
      if (recovered != null && recovered !== frameId) {
        try {
          const retry = await sendToTab<ContentResponse>(
            tabId,
            { type: 'PREVIEW_STEPS', key, steps: list },
            recovered,
          )
          return retry ?? { ok: false, message: '内容脚本无响应' }
        } catch (retryError) {
          return { ok: false, message: frameConnectionMessage((retryError as Error).message) }
        }
      }
      return { ok: false, message: frameConnectionMessage((error as Error).message) }
    }
  }

  const clearWorkflowPreview = () => {
    if (tabId == null) return
    void sendToTab(tabId, { type: 'CLEAR_PREVIEW' }).catch(() => undefined)
  }

  const stop = async () => {
    if (tabId == null) return
    try {
      const response = await sendToTab<ContentResponse>(tabId, { type: 'CANCEL_AUTOMATION' })
      // 内容脚本已无流程在跑（例如页面刷新过），直接解除本地锁定
      if (!response?.running) {
        runIdRef.current = null
        setRunning(false)
        setNotice('')
      }
    } catch {
      runIdRef.current = null
      setRunning(false)
    }
  }

  const copyResults = async () => {
    await navigator.clipboard.writeText(JSON.stringify(results, null, 2))
    setCopied(true)
  }

  return (
    <section className="mr-section">
      <WorkflowPanel
        steps={steps}
        pageUrl={pageUrl}
        connected={connected}
        busy={running || pickingStepId != null}
        editingId={editingWorkflow?.id ?? null}
        editingDirty={editingDirty}
        onLoad={loadWorkflowForEdit}
        onRun={(list, label) => void runSteps(list, label)}
        onPreview={previewWorkflowSteps}
        onClearPreview={clearWorkflowPreview}
      />

      <AiWorkflowCard
        tabId={tabId}
        connected={connected}
        busy={running || pickingStepId != null}
        stepCount={steps.length}
        onGenerated={(list) => {
          // 页面上的旧标注对应的是之前的步骤，生成后清掉
          clearWorkflowPreview()
          applyWorkflow(list)
          // 生成结果在编辑器里，滚动过去让用户马上看到
          window.requestAnimationFrame(() => {
            document.getElementById('mr-steps-section')?.scrollIntoView({ block: 'start' })
          })
        }}
      />

      <div className="mr-section-head" id="mr-steps-section">
        <h2>
          流程编排 <span className="mr-count">{steps.length}</span>
        </h2>
        <span className="mr-hint">{actionSummary}</span>
      </div>

      {editingWorkflow && (
        <div className="mr-edit-bar">
          <div className="mr-edit-info">
            <span className="mr-edit-label">正在编辑</span>
            <strong className="mr-edit-name" title={editingWorkflow.name}>
              {editingWorkflow.name}
            </strong>
            <span className={`mr-edit-state${editingDirty ? ' is-dirty' : ''}`}>
              {editingDirty ? '有未保存修改' : '已保存'}
            </span>
          </div>
          <div className="mr-edit-actions">
            <button
              type="button"
              className="mr-btn mr-btn-primary"
              disabled={!editingDirty || !steps.length || savingEdit}
              title={!steps.length ? '工作流至少需要一个步骤' : undefined}
              onClick={() => void saveEditingWorkflow()}
            >
              {savingEdit ? '保存中…' : '保存修改'}
            </button>
            <button type="button" className="mr-btn mr-btn-ghost" onClick={exitEditing}>
              退出编辑
            </button>
          </div>
        </div>
      )}

      {editingWorkflow && editFeedback && (
        <div className={`mr-feedback ${editFeedback.kind}`}>{editFeedback.text}</div>
      )}

      {steps.length === 0 ? (
        <div className="mr-card mr-empty-card">
          <p>还没有步骤。点击「添加步骤」开始，例如：</p>
          <p className="mr-hint">提取标题 → 滚动到底部 → 点击「加载更多」</p>
        </div>
      ) : (
        <ol className="mr-steps">
          {steps.map((step, index) => (
            <li
              key={step.id}
              className={`mr-step${draggingId === step.id ? ' is-dragging' : ''}${
                dropTarget?.id === step.id
                  ? dropTarget.after
                    ? ' is-drop-after'
                    : ' is-drop-before'
                  : ''
              }`}
              onDragOver={(event) => hoverStep(event, step.id)}
              onDragLeave={(event) => {
                const next = event.relatedTarget
                if (next instanceof Node && event.currentTarget.contains(next)) return
                setDropTarget((current) => (current?.id === step.id ? null : current))
              }}
              onDrop={(event) => dropOnStep(event, step.id)}
            >
              <div className="mr-step-head">
                <span
                  className="mr-drag-handle"
                  draggable
                  title="拖动调整顺序"
                  aria-hidden="true"
                  onDragStart={(event) => startDrag(event, step.id)}
                  onDragEnd={endDrag}
                >
                  ⠿
                </span>
                <span className="mr-step-index">{index + 1}</span>
                <ActionSelect
                  ariaLabel={`步骤 ${index + 1} 动作`}
                  value={step.action}
                  options={ACTION_OPTIONS}
                  onChange={(action) =>
                    updateStep(step.id, {
                      action: action as AutomationAction,
                      value: '',
                      all: false,
                    })
                  }
                />
                {step.frameId != null && step.frameId !== 0 && (
                  <span
                    className="mr-frame-badge"
                    title={`该步骤在 iframe 内执行（frame ${step.frameId}）`}
                  >
                    iframe
                  </span>
                )}
                <div className="mr-step-tools">
                  <button
                    type="button"
                    className="mr-icon-btn"
                    title="上移"
                    disabled={index === 0}
                    onClick={() => moveStep(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="mr-icon-btn"
                    title="下移"
                    disabled={index === steps.length - 1}
                    onClick={() => moveStep(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="mr-icon-btn mr-icon-danger"
                    title="删除步骤"
                    onClick={() => removeStep(step.id)}
                  >
                    ×
                  </button>
                </div>
              </div>

              {step.action !== 'wait' && (
                <div className="mr-field">
                  <label>选择器</label>
                  <div className="mr-input-row">
                    <input
                      className="mr-input mr-mono"
                      value={step.selector}
                      placeholder={
                        step.action === 'scroll' ? '可选：滚动到某个元素' : 'CSS 选择器，如 .btn'
                      }
                      onChange={(event) => updateStep(step.id, { selector: event.target.value })}
                    />
                    <button
                      type="button"
                      className={`mr-icon-btn mr-pick-btn${
                        pickingStepId === step.id ? ' is-active' : ''
                      }`}
                      title={pickingStepId === step.id ? '取消点选' : '在页面上点选元素'}
                      disabled={!connected}
                      onClick={() => void pick(step.id)}
                    >
                      ⌖
                    </button>
                  </div>
                </div>
              )}

              {step.action !== 'click' && (
                <div className="mr-field">
                  <label>{valueLabel(step.action)}</label>
                  <input
                    className="mr-input"
                    value={step.value}
                    placeholder={valuePlaceholder(step.action)}
                    onChange={(event) => updateStep(step.id, { value: event.target.value })}
                  />
                </div>
              )}

              {(step.action === 'click' || step.action === 'input') && (
                <label className="mr-check">
                  <input
                    type="checkbox"
                    checked={Boolean(step.all)}
                    onChange={(event) => updateStep(step.id, { all: event.target.checked })}
                  />
                  应用到所有匹配元素
                </label>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="mr-row-between">
        <button type="button" className="mr-btn" onClick={addStep}>
          ＋ 添加步骤
        </button>
        {steps.length > 0 && (
          <button type="button" className="mr-btn mr-btn-ghost" onClick={clearSteps}>
            清空
          </button>
        )}
      </div>

      <div className="mr-run-row">
        <button
          type="button"
          className="mr-btn mr-btn-primary"
          disabled={!canRun || running}
          onClick={() => void runSteps(steps)}
        >
          {running ? '执行中…' : '运行流程'}
        </button>
        {running && (
          <button type="button" className="mr-btn mr-btn-ghost" onClick={() => void stop()}>
            停止
          </button>
        )}
      </div>

      {error && <div className="mr-feedback error">{error}</div>}
      {notice && !error && <div className="mr-feedback info">{notice}</div>}
      {pickingStepId && (
        <div className="mr-feedback info">
          请在网页中点击要操作的元素（iframe 内也可以）；点击哪里就选中哪里，Esc 取消。
        </div>
      )}

      <div className="mr-card">
        <div className="mr-card-head">
          <h3>执行日志</h3>
          {logs.length > 0 && (
            <button
              type="button"
              className="mr-btn mr-btn-ghost"
              onClick={() => setLogs([])}
            >
              清空
            </button>
          )}
        </div>
        <div className="mr-log">
          {logs.length === 0 ? (
            <p className="mr-empty-inline">尚未执行。</p>
          ) : (
            logs.map((entry, index) => (
              <div key={`${index}-${entry.message}`} className={`mr-log-line ${entry.level}`}>
                {entry.message}
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>

      {results.length > 0 && (
        <div className="mr-card">
          <div className="mr-card-head">
            <h3>提取结果</h3>
            <button type="button" className="mr-btn mr-btn-ghost" onClick={() => void copyResults()}>
              {copied ? '已复制' : '复制 JSON'}
            </button>
          </div>
          {results.map((result) => (
            <div key={result.stepIndex} className="mr-result">
              <div className="mr-result-head">
                <code>{result.selector}</code>
                <span>{result.values.length} 条</span>
              </div>
              {result.values.length === 0 ? (
                <p className="mr-empty-inline">没有匹配到内容。</p>
              ) : (
                <ol className="mr-result-list">
                  {result.values.map((value, index) => (
                    <li key={index}>{value || <em>（空）</em>}</li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
