import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'

import { normalizeStep } from '../shared/steps'
import {
  siteOrigin,
  STORAGE_WORKFLOWS,
  type AutomationStep,
  type ContentResponse,
  type Workflow,
  type WorkflowScope,
} from '../shared/types'
import { getStorage, setStorage } from './messaging'

interface Props {
  steps: AutomationStep[]
  pageUrl: string
  connected: boolean
  /** 正在运行流程或正在点选元素 */
  busy: boolean
  /** 当前加载到编辑器中修改的工作流 */
  editingId: string | null
  editingDirty: boolean
  onLoad: (steps: AutomationStep[], workflow: Workflow) => void
  onRun: (steps: AutomationStep[], label?: string) => void
  /** 在页面标注工作流会操作的元素；再次调用同一个 key 表示取消 */
  onPreview: (steps: AutomationStep[], key: string) => Promise<ContentResponse>
  onClearPreview: () => void
}

interface Feedback {
  kind: 'success' | 'error' | 'info'
  text: string
}

function copySteps(steps: AutomationStep[]): AutomationStep[] {
  return steps.map((step) => ({ ...step }))
}

function safeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\r\n\t]/g, '-')
      .replace(/\s+/g, ' ')
      .trim() || 'workflow'
  )
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // 立即 revoke 在部分平台会中断下载，延迟释放
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 兼容三种结构：导出的外层封装、单个 Workflow、Workflow 数组 */
function collectRawWorkflows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data.flatMap(collectRawWorkflows)
  if (!data || typeof data !== 'object') return []

  const record = data as Record<string, unknown>
  if (record.workflow !== undefined) return collectRawWorkflows(record.workflow)
  if (Array.isArray(record.workflows)) return record.workflows.flatMap(collectRawWorkflows)
  return [data]
}

function normalizeWorkflow(raw: unknown, origin: string): Workflow | null {
  if (!raw || typeof raw !== 'object') return null

  const record = raw as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name || !Array.isArray(record.steps) || !record.steps.length) return null

  const steps: AutomationStep[] = []
  for (const item of record.steps) {
    const step = normalizeStep(item)
    if (!step) return null
    steps.push(step)
  }

  // 站点作用域跟随导入时的页面，避免换环境后工作流被过滤掉、看起来像没导入；
  // 无法取得 origin 时降级为全局。
  const siteScoped = record.scope !== 'global'
  const scope: WorkflowScope = siteScoped && origin ? 'site' : 'global'
  const now = Date.now()
  const createdAt =
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
      ? record.createdAt
      : now

  return {
    id: crypto.randomUUID(),
    name,
    steps,
    scope,
    origin: scope === 'site' ? origin : '',
    createdAt,
    updatedAt: now,
  }
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }

  let index = 2
  let candidate = `${base}（导入）`
  while (used.has(candidate)) {
    candidate = `${base}（导入 ${index}）`
    index += 1
  }
  used.add(candidate)
  return candidate
}

export function WorkflowPanel({
  steps,
  pageUrl,
  connected,
  busy,
  editingId,
  editingDirty,
  onLoad,
  onRun,
  onPreview,
  onClearPreview,
}: Props) {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<WorkflowScope>('site')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)

  const skipRenameBlurRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const origin = useMemo(() => siteOrigin(pageUrl), [pageUrl])

  const visible = useMemo(() => {
    return workflows
      .filter(
        (workflow) =>
          workflow.scope === 'global' || (origin !== '' && workflow.origin === origin),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [workflows, origin])

  const loadAll = useCallback(async () => {
    const data = await getStorage<Record<string, Workflow[] | undefined>>(STORAGE_WORKFLOWS)
    const list = data[STORAGE_WORKFLOWS]
    setWorkflows(Array.isArray(list) ? list : [])
    setHydrated(true)
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // 编辑器保存修改 / 其他侧边栏修改工作流时，同步刷新列表
  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local' && changes[STORAGE_WORKFLOWS]) void loadAll()
    }

    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }, [loadAll])

  // 切到另一个页面时，收起未提交的保存表单和重命名输入
  useEffect(() => {
    setFormOpen(false)
    setRenamingId(null)
    setFeedback(null)
    setPreviewId(null)
  }, [pageUrl])

  // 内容脚本在开始运行 / 点选时会清除页面标注，这里同步本地状态
  useEffect(() => {
    if (busy) setPreviewId(null)
  }, [busy])

  useEffect(() => {
    if (!connected) setPreviewId(null)
  }, [connected])

  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(null), 2600)
    return () => window.clearTimeout(timer)
  }, [feedback])

  /** 读最新列表 → 修改 → 写回，避免 hydration/focus 竞态丢数据 */
  const persist = async (update: (list: Workflow[]) => Workflow[]): Promise<boolean> => {
    try {
      const data = await getStorage<Record<string, Workflow[] | undefined>>(
        STORAGE_WORKFLOWS,
      )
      const list = Array.isArray(data[STORAGE_WORKFLOWS]) ? data[STORAGE_WORKFLOWS] : []
      const next = update(list)
      await setStorage({ [STORAGE_WORKFLOWS]: next })
      setWorkflows(next)
      return true
    } catch (error) {
      setFeedback({ kind: 'error', text: (error as Error).message })
      return false
    }
  }

  const openForm = () => {
    if (!steps.length) return
    const editing = editingId
      ? workflows.find((workflow) => workflow.id === editingId)
      : undefined
    setFormOpen(true)
    // 编辑中另存为时给个可用的默认名，避免和原工作流同名
    setName(editing ? `${editing.name}（副本）` : '')
    setScope(editing?.scope ?? (origin ? 'site' : 'global'))
    setRenamingId(null)
  }

  const closeForm = () => {
    setFormOpen(false)
    setName('')
    setFeedback(null)
  }

  const saveWorkflow = async () => {
    const trimmed = name.trim()
    if (!trimmed || !steps.length) return

    if (visible.some((workflow) => workflow.name === trimmed)) {
      if (!window.confirm('已存在同名工作流，仍要保存吗？')) return
    }

    const now = Date.now()
    const workflow: Workflow = {
      id: crypto.randomUUID(),
      name: trimmed,
      steps: copySteps(steps),
      scope: origin ? scope : 'global',
      origin: origin && scope === 'site' ? origin : '',
      createdAt: now,
      updatedAt: now,
    }

    const ok = await persist((list) => [workflow, ...list])
    if (!ok) return

    setFormOpen(false)
    setName('')
    setFeedback({ kind: 'success', text: `已保存工作流「${trimmed}」` })
  }

  const beginRename = (workflow: Workflow) => {
    skipRenameBlurRef.current = false
    setRenamingId(workflow.id)
    setRenameValue(workflow.name)
    setFormOpen(false)
  }

  const commitRename = async (id: string) => {
    const trimmed = renameValue.trim()
    setRenamingId(null)
    if (!trimmed) return

    const current = workflows.find((workflow) => workflow.id === id)
    if (!current || current.name === trimmed) return

    const ok = await persist((list) =>
      list.map((workflow) =>
        workflow.id === id ? { ...workflow, name: trimmed, updatedAt: Date.now() } : workflow,
      ),
    )
    if (ok) setFeedback({ kind: 'success', text: '工作流已重命名' })
  }

  const remove = async (workflow: Workflow) => {
    if (!window.confirm(`删除工作流「${workflow.name}」？`)) return

    if (previewId === workflow.id) {
      onClearPreview()
      setPreviewId(null)
    }

    const ok = await persist((list) => list.filter((item) => item.id !== workflow.id))
    if (ok) setFeedback({ kind: 'success', text: '工作流已删除' })
  }

  const togglePreview = async (workflow: Workflow) => {
    if (!connected) {
      setFeedback({ kind: 'error', text: '当前页面未连接内容脚本，无法标注' })
      return
    }
    if (busy) {
      setFeedback({ kind: 'info', text: '流程执行中，暂时无法标注' })
      return
    }

    try {
      const response = await onPreview(copySteps(workflow.steps), workflow.id)
      if (!response?.ok) {
        setFeedback({ kind: 'error', text: response?.message || '无法在页面标注' })
        return
      }

      setPreviewId(response.previewing ? workflow.id : null)
      setFeedback({
        // 一个元素都没匹配上时用红色反馈，避免用户以为「点了没反应」
        kind: response.previewing && !response.matched ? 'error' : 'success',
        text:
          response.message ||
          (response.previewing ? '已在页面标注' : '已清除页面标注'),
      })
    } catch (error) {
      setFeedback({ kind: 'error', text: `标注失败：${(error as Error).message}` })
    }
  }

  const exportWorkflow = (workflow: Workflow) => {
    // 带版本号的外层结构，方便以后做导入时校验格式
    const payload = {
      type: 'mindrepetition.workflow',
      version: 1,
      exportedAt: new Date().toISOString(),
      workflow,
    }

    try {
      downloadJson(`mindrepetition-${safeFileName(workflow.name)}.json`, payload)
      setFeedback({ kind: 'success', text: `已导出「${workflow.name}」` })
    } catch (error) {
      setFeedback({ kind: 'error', text: `导出失败：${(error as Error).message}` })
    }
  }

  const importWorkflows = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 清空后再次选择同一个文件也能触发 change
    event.target.value = ''
    if (!file) return

    try {
      const text = await file.text()
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error('文件不是有效的 JSON')
      }

      const raws = collectRawWorkflows(data)
      if (!raws.length) throw new Error('没有找到工作流数据')

      const parsed = raws.map((raw) => normalizeWorkflow(raw, origin))
      const imported = parsed.filter(
        (workflow): workflow is Workflow => workflow !== null,
      )
      const skipped = parsed.length - imported.length
      if (!imported.length) throw new Error('工作流数据格式不正确')

      const ok = await persist((list) => {
        const used = new Set(list.map((workflow) => workflow.name))
        const prepared = imported.map((workflow) => ({
          ...workflow,
          name: uniqueName(workflow.name, used),
        }))
        return [...prepared, ...list]
      })
      if (!ok) return

      setFormOpen(false)
      setRenamingId(null)
      setFeedback({
        kind: 'success',
        text: skipped
          ? `已导入 ${imported.length} 个工作流，跳过 ${skipped} 个无效项`
          : `已导入 ${imported.length} 个工作流`,
      })
    } catch (error) {
      setFeedback({ kind: 'error', text: `导入失败：${(error as Error).message}` })
    }
  }

  const loadWorkflow = (workflow: Workflow) => {
    if (busy) return

    if (editingDirty) {
      if (!window.confirm('当前编辑有未保存的修改，加载其他工作流会丢弃这些修改，继续？')) return
    } else if (editingId !== workflow.id && steps.length) {
      if (!window.confirm('加载工作流会替换当前步骤，继续？')) return
    }

    // 步骤即将变化，旧的页面标注已经失效
    if (previewId === workflow.id) {
      onClearPreview()
      setPreviewId(null)
    }

    onLoad(copySteps(workflow.steps), workflow)
    setFeedback({
      kind: 'success',
      text:
        editingId === workflow.id
          ? `已重新加载「${workflow.name}」`
          : `正在编辑「${workflow.name}」，修改后点上方「保存修改」写回`,
    })
  }

  const runWorkflow = (workflow: Workflow) => {
    if (!connected || busy) return
    // 内容脚本在开始执行时会清除标注
    setPreviewId(null)
    onRun(copySteps(workflow.steps), workflow.name)
  }

  return (
    <div className="mr-card mr-wf-card">
      <div className="mr-card-head">
        <h3>
          工作流 <span className="mr-count">{visible.length}</span>
        </h3>
        {!formOpen && (
          <div className="mr-wf-head-actions">
            <button
              type="button"
              className="mr-btn mr-btn-ghost"
              disabled={!hydrated}
              title="从 JSON 文件导入工作流"
              onClick={() => fileInputRef.current?.click()}
            >
              导入
            </button>
            <button
              type="button"
              className="mr-btn mr-btn-ghost"
              disabled={!hydrated || !steps.length}
              title={
                !steps.length
                  ? '先添加至少一个步骤'
                  : editingId
                    ? '把当前步骤另存为新工作流'
                    : '把当前步骤保存为工作流'
              }
              onClick={openForm}
            >
              {editingId ? '另存为' : '＋ 保存'}
            </button>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => void importWorkflows(event)}
      />

      {formOpen && (
        <div className="mr-wf-form">
          <input
            className="mr-input"
            autoFocus
            value={name}
            placeholder="工作流名称，例如「商品详情采集」"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void saveWorkflow()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                closeForm()
              }
            }}
          />

          <div className="mr-wf-scope" role="group" aria-label="适用范围">
            <button
              type="button"
              className={scope === 'site' ? 'is-active' : ''}
              disabled={!origin}
              aria-pressed={scope === 'site'}
              onClick={() => setScope('site')}
            >
              仅当前站点
            </button>
            <button
              type="button"
              className={scope === 'global' ? 'is-active' : ''}
              aria-pressed={scope === 'global'}
              onClick={() => setScope('global')}
            >
              全局
            </button>
          </div>

          {!origin && (
            <p className="mr-hint">当前页面没有可用的网站地址，只能保存为全局工作流。</p>
          )}

          <div className="mr-wf-form-actions">
            <button type="button" className="mr-btn mr-btn-ghost" onClick={closeForm}>
              取消
            </button>
            <button
              type="button"
              className="mr-btn mr-btn-primary"
              disabled={!hydrated || !name.trim()}
              onClick={() => void saveWorkflow()}
            >
              保存
            </button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="mr-empty-inline">
          {steps.length
            ? '还没有保存的工作流。点右上角「保存」，把当前步骤存成可复用的工作流。'
            : '还没有工作流。先添加步骤，再点右上角保存。'}
        </p>
      ) : (
        <ul className="mr-wf-list">
          {visible.map((workflow) => (
            <li
              key={workflow.id}
              className={`mr-wf-item${previewId === workflow.id ? ' is-previewing' : ''}${
                editingId === workflow.id ? ' is-editing' : ''
              }`}
            >
              {renamingId === workflow.id ? (
                <div className="mr-wf-main">
                  <input
                    className="mr-input mr-wf-rename"
                    autoFocus
                    value={renameValue}
                    aria-label="工作流名称"
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => {
                      if (skipRenameBlurRef.current) {
                        skipRenameBlurRef.current = false
                        return
                      }
                      void commitRename(workflow.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        event.currentTarget.blur()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        skipRenameBlurRef.current = true
                        setRenamingId(null)
                      }
                    }}
                  />
                  <span className="mr-wf-meta">
                    {workflow.steps.length} 步 ·{' '}
                    {workflow.scope === 'global' ? '全局' : '仅本站'}
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  className="mr-wf-main mr-wf-preview"
                  title={
                    connected
                      ? '点击在页面标注该工作流会操作的元素；再次点击取消'
                      : '当前页面未连接内容脚本'
                  }
                  aria-pressed={previewId === workflow.id}
                  onClick={() => void togglePreview(workflow)}
                >
                  <span className="mr-wf-name" title={workflow.name}>
                    {workflow.name}
                  </span>
                  <span className="mr-wf-meta">
                    {workflow.steps.length} 步 ·{' '}
                    {workflow.scope === 'global' ? '全局' : '仅本站'}
                    {editingId === workflow.id ? ' · 编辑中' : ''}
                  </span>
                </button>
              )}

              <div className="mr-wf-actions">
                <button
                  type="button"
                  className="mr-btn mr-btn-ghost"
                  disabled={busy}
                  title={
                    editingId === workflow.id
                      ? '重新加载该工作流（会丢弃未保存的修改）'
                      : '加载到编辑器，修改步骤后保存回该工作流'
                  }
                  onClick={() => loadWorkflow(workflow)}
                >
                  {editingId === workflow.id ? '重新加载' : '编辑'}
                </button>
                <button
                  type="button"
                  className="mr-icon-btn mr-wf-run-btn"
                  disabled={!connected || busy}
                  title={connected ? '直接运行该工作流' : '当前页面未连接内容脚本'}
                  onClick={() => runWorkflow(workflow)}
                >
                  ▶
                </button>
                <button
                  type="button"
                  className="mr-btn mr-btn-ghost"
                  title="导出为 JSON 文件"
                  onClick={() => exportWorkflow(workflow)}
                >
                  导出
                </button>
                <button
                  type="button"
                  className="mr-icon-btn"
                  title="重命名"
                  onClick={() => beginRename(workflow)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="mr-icon-btn mr-icon-danger"
                  title="删除工作流"
                  onClick={() => void remove(workflow)}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {visible.length > 0 && (
        <p className="mr-hint">
          点击名称可标注页面元素；点「编辑」加载到下方增删改步骤，改完点「保存修改」写回。
        </p>
      )}

      {feedback && <div className={`mr-feedback ${feedback.kind}`}>{feedback.text}</div>}
    </div>
  )
}
