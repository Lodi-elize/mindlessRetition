import { useEffect, useRef, useState } from 'react'

import type { AiPreset, AiSettings, AutomationStep } from '../shared/types'
import { requestChatCompletion } from './aiClient'
import {
  applyPreset,
  DEFAULT_AI_SETTINGS,
  isLocalEndpoint,
  loadAiSettings,
  PRESET_OPTIONS,
  saveAiSettings,
} from './aiSettings'
import { buildSystemPrompt, buildUserPrompt, parseWorkflowResponse } from './aiWorkflow'
import { collectFrameContexts, mergeFrameContexts } from './frames'

interface Props {
  tabId: number | null
  connected: boolean
  /** 正在运行流程或点选元素 */
  busy: boolean
  stepCount: number
  onGenerated: (steps: AutomationStep[]) => void
}

interface Feedback {
  kind: 'success' | 'error' | 'info'
  text: string
}

export function AiWorkflowCard({ tabId, connected, busy, stepCount, onGenerated }: Props) {
  const [draft, setDraft] = useState<AiSettings>(DEFAULT_AI_SETTINGS)
  const [hydrated, setHydrated] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const targetRef = useRef({ tabId, connected })
  const stepCountRef = useRef(stepCount)

  useEffect(() => {
    targetRef.current = { tabId, connected }
  }, [tabId, connected])

  useEffect(() => {
    stepCountRef.current = stepCount
  }, [stepCount])

  useEffect(() => {
    let alive = true
    void loadAiSettings()
      .then((loaded) => {
        if (!alive) return
        setDraft(loaded)
        setPrompt(loaded.lastPrompt ?? '')
        setHydrated(true)
        // 远端接口没有 Key 时先展开设置，避免用户点生成后才报错
        if (!loaded.apiKey.trim() && !isLocalEndpoint(loaded.baseUrl)) setSettingsOpen(true)
      })
      .catch(() => {
        if (alive) setHydrated(true)
      })

    return () => {
      alive = false
    }
  }, [])

  // 组件卸载时中断请求，避免结果写回已卸载的面板
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // 切换页面 / 标签页 / 断开连接时，旧页面的生成结果已经失去意义
  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setGenerating(false)
    setFeedback(null)
  }, [tabId, connected])

  const saveDraft = async (): Promise<boolean> => {
    const next: AiSettings = {
      ...draft,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim(),
    }

    if (!next.baseUrl) {
      setFeedback({ kind: 'error', text: '请填写 Base URL，例如 https://api.deepseek.com/v1' })
      return false
    }
    if (!next.model) {
      setFeedback({ kind: 'error', text: '请填写模型名称，例如 deepseek-chat' })
      return false
    }
    if (!isLocalEndpoint(next.baseUrl) && !next.apiKey) {
      setSettingsOpen(true)
      setFeedback({ kind: 'error', text: '请填写 API Key。使用本地服务时可留空。' })
      return false
    }

    try {
      await saveAiSettings(next)
      setDraft(next)
      return true
    } catch (error) {
      setFeedback({ kind: 'error', text: `设置保存失败：${(error as Error).message}` })
      return false
    }
  }

  const commitSettings = async () => {
    const ok = await saveDraft()
    if (!ok) return
    setSettingsOpen(false)
    setFeedback({ kind: 'success', text: '设置已保存' })
  }

  const cancel = () => {
    abortRef.current?.abort()
  }

  const generate = async () => {
    if (generating) return

    const task = prompt.trim()
    if (!task) {
      setFeedback({ kind: 'error', text: '请先用一句话描述要完成的任务。' })
      return
    }
    if (tabId == null || !connected) {
      setFeedback({ kind: 'error', text: '当前页面未连接内容脚本，无法读取页面元素。' })
      return
    }

    const effective: AiSettings = {
      preset: draft.preset,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim(),
      lastPrompt: task,
    }

    if (stepCount > 0 && !window.confirm(`生成会替换编辑器中的 ${stepCount} 个步骤，继续？`)) {
      return
    }

    // 先创建中断控制器并进入生成态，避免 saveDraft 的等待窗口里漏掉切页 / 重复点击
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    setGenerating(true)
    setFeedback(null)

    const startStepCount = stepCount

    try {
      const saved = await saveDraft()
      if (!saved) return
      if (controller.signal.aborted || targetRef.current.tabId !== tabId) return

      // 记住这次描述，下次打开面板时还能直接修改
      void saveAiSettings(effective).catch(() => undefined)

      // 汇总顶层与所有 iframe 的元素摘要，生成的选择器按 frame 路由
      const frameEntries = await collectFrameContexts(tabId)
      if (controller.signal.aborted || targetRef.current.tabId !== tabId) return

      if (!frameEntries.length) {
        throw new Error('无法连接当前页面的内容脚本，请刷新页面后重试。')
      }

      const context = mergeFrameContexts(frameEntries)
      if (!context.elements.length && !context.content.length) {
        throw new Error('当前页面没有找到可识别的元素，请换一个页面或刷新后重试。')
      }

      const content = await requestChatCompletion({
        baseUrl: effective.baseUrl,
        apiKey: effective.apiKey,
        model: effective.model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserPrompt(task, context) },
        ],
        signal: controller.signal,
      })

      if (controller.signal.aborted || targetRef.current.tabId !== tabId) return

      const parsed = parseWorkflowResponse(content, context)
      if (!parsed.ok) throw new Error(parsed.error)

      // 请求期间编辑器可能被改动过，替换前再确认一次
      if (
        stepCountRef.current !== startStepCount &&
        !window.confirm(
          `生成期间编辑器中的步骤已变化，仍要替换当前的 ${stepCountRef.current} 个步骤吗？`,
        )
      ) {
        return
      }

      setDraft((current) => ({ ...current, lastPrompt: task }))
      onGenerated(parsed.value.steps)

      setFeedback({
        kind: 'success',
        text: parsed.value.warnings.length
          ? `已生成 ${parsed.value.steps.length} 个步骤并填入编辑器。${parsed.value.warnings.join(' ')}`
          : `已生成 ${parsed.value.steps.length} 个步骤并填入编辑器，可修改后运行或保存为工作流。`,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        if (abortRef.current === controller) {
          setFeedback({ kind: 'info', text: '已取消生成。' })
        }
        return
      }
      setFeedback({ kind: 'error', text: (error as Error).message })
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setGenerating(false)
      }
    }
  }

  const canGenerate =
    hydrated &&
    connected &&
    tabId != null &&
    prompt.trim().length > 0 &&
    !generating &&
    !busy

  return (
    <div className="mr-card mr-ai-card">
      <div className="mr-card-head">
        <h3>
          <button
            type="button"
            className="mr-ai-head-toggle"
            aria-expanded={expanded}
            aria-controls="mr-ai-body"
            onClick={() => setExpanded((open) => !open)}
          >
            <span className={`mr-ai-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true">
              ›
            </span>
            <span>AI 生成流程</span>
          </button>
        </h3>
        {expanded && (
          <button
            type="button"
            className="mr-btn mr-btn-ghost"
            disabled={!hydrated}
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            {settingsOpen ? '收起设置' : '设置'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="mr-ai-body" id="mr-ai-body">
          <textarea
            className="mr-textarea mr-ai-prompt"
            aria-label="描述要完成的任务"
            value={prompt}
            rows={3}
            placeholder="例如：在搜索框输入「耳机」，点击搜索，等待结果加载，提取所有商品价格"
            disabled={generating || !hydrated}
            onChange={(event) => setPrompt(event.target.value)}
          />

          <p className="mr-hint mr-ai-footnote">
            生成时会把页面标题、链接、按钮和文本摘要发送到所配置的接口；不会发送输入框内容。
          </p>

          <div className="mr-ai-actions">
            <button
              type="button"
              className="mr-btn mr-btn-primary"
              disabled={!canGenerate}
              onClick={() => void generate()}
            >
              {generating ? '生成中…' : '生成流程'}
            </button>
            {generating && (
              <button type="button" className="mr-btn mr-btn-ghost" onClick={cancel}>
                取消
              </button>
            )}
            {!connected && <span className="mr-hint">当前页面未连接内容脚本</span>}
          </div>

          {settingsOpen && (
            <div className="mr-wf-form mr-ai-settings">
              <div className="mr-field">
                <label>服务预设</label>
                <select
                  className="mr-input"
                  value={draft.preset}
                  disabled={generating}
                  onChange={(event) =>
                    setDraft((current) => applyPreset(event.target.value as AiPreset, current))
                  }
                >
                  {PRESET_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mr-field">
                <label>Base URL</label>
                <input
                  className="mr-input mr-mono"
                  value={draft.baseUrl}
                  spellCheck={false}
                  placeholder="https://api.deepseek.com/v1"
                  disabled={generating}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, baseUrl: event.target.value }))
                  }
                />
              </div>

              <div className="mr-field">
                <label>模型</label>
                <input
                  className="mr-input mr-mono"
                  value={draft.model}
                  spellCheck={false}
                  placeholder="deepseek-chat"
                  disabled={generating}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, model: event.target.value }))
                  }
                />
              </div>

              <div className="mr-field">
                <label>API Key</label>
                <input
                  className="mr-input"
                  type="password"
                  autoComplete="off"
                  value={draft.apiKey}
                  placeholder="本地服务（Ollama 等）可留空"
                  disabled={generating}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, apiKey: event.target.value }))
                  }
                />
              </div>

              <p className="mr-hint">
                Key 以明文保存在本机扩展存储中，只会发送到上面填写的接口。对话内容不会上传到其他服务。
              </p>

              <div className="mr-wf-form-actions">
                <button
                  type="button"
                  className="mr-btn mr-btn-primary"
                  disabled={!hydrated}
                  onClick={() => void commitSettings()}
                >
                  保存设置
                </button>
              </div>
            </div>
          )}

          {feedback && <div className={`mr-feedback ${feedback.kind}`}>{feedback.text}</div>}
        </div>
      )}
    </div>
  )
}
