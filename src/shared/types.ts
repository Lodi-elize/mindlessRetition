/** 标注在页面中的定位信息，用于页面刷新后重新高亮 */
export interface AnnotationAnchor {
  startXpath: string
  startOffset: number
  endXpath: string
  endOffset: number
  /** 在整页文本中的起始字符偏移。插入/移除高亮不会改变该偏移，用于精确还原重复文本 */
  textOffset?: number
}

/** 元素级标注的定位信息 */
export interface ElementAnchor {
  /** 用于重新定位元素的 CSS 选择器 */
  selector: string
  /** 元素标签名，如 div / button */
  tag: string
  /** 元素文本片段，便于在列表里辨认 */
  text: string
}

export interface Annotation {
  id: string
  /** 添加标注时的页面 URL（忽略 hash） */
  url: string
  /** 标注位于 iframe 时，该 frame 自身的 URL；顶层文档为空 */
  frameUrl?: string
  title: string
  /** 被标注的原文；元素标注时为元素文本片段 */
  text: string
  /** 用户填写的备注，可为空 */
  note: string
  createdAt: number
  anchor?: AnnotationAnchor
  /** 标注类型；缺省视为文字标注，兼容旧数据 */
  mode?: 'text' | 'element'
  /** 元素标注的定位信息 */
  element?: ElementAnchor
}

export type AutomationAction = 'click' | 'input' | 'scroll' | 'extract' | 'wait'

export interface AutomationStep {
  id: string
  action: AutomationAction
  selector: string
  value: string
  /** 点击 / 输入时是否作用于所有匹配元素 */
  all?: boolean
  /** 步骤所在 frame：0 为顶层文档，其它值表示点选时所在的 iframe */
  frameId?: number
}

export interface ExtractResult {
  stepIndex: number
  selector: string
  values: string[]
}

export type WorkflowScope = 'site' | 'global'

/** 用户保存的可复用步骤序列 */
export interface Workflow {
  id: string
  name: string
  steps: AutomationStep[]
  scope: WorkflowScope
  /** 保存时的网站 origin；global 作用域为空字符串 */
  origin: string
  createdAt: number
  updatedAt: number
}

/** AI 生成流程所用的 OpenAI 兼容接口配置；保存在本机 chrome.storage.local */
export type AiPreset = 'deepseek' | 'openai' | 'kimi' | 'qwen' | 'ollama' | 'custom'

export interface AiSettings {
  preset: AiPreset
  /** 兼容接口根地址，如 https://api.deepseek.com/v1 */
  baseUrl: string
  apiKey: string
  model: string
  /** 上次描述，便于再次生成时修改 */
  lastPrompt?: string
}

export interface PageSelectOption {
  value: string
  text: string
}

/** 页面元素摘要，作为 AI 生成选择器的依据 */
export interface PageElementSummary {
  selector: string
  tag: string
  /** 可见文本 / 标签，最长 80 字 */
  text?: string
  /** aria-label / placeholder / alt / title / name 中第一个非空值 */
  name?: string
  type?: string
  /** 该选择器在页面中匹配的元素数量 */
  matchCount: number
  /** select 的前若干个选项 */
  options?: PageSelectOption[]
  /** 元素所在 frame；0 为顶层文档。由侧边栏汇总时填写 */
  frameId?: number
}

export interface PageFrameSummary {
  frameId: number
  url: string
  title: string
}

export interface PageContext {
  url: string
  title: string
  headings: string[]
  /** 可交互元素：click / input / scroll */
  elements: PageElementSummary[]
  /** 内容元素：仅建议用于 extract */
  content: PageElementSummary[]
  totalCandidates: number
  /** 元素过多、摘要被截断 */
  truncated: boolean
  /** 汇总多个 frame 时记录各 frame 的来源 */
  frames?: PageFrameSummary[]
}

export type AutomationLogLevel = 'info' | 'success' | 'warn' | 'error'

/** 侧边栏 -> 内容脚本 */
export type ToContentMessage =
  | { type: 'PING' }
  | { type: 'GET_SELECTION' }
  | { type: 'CREATE_ANNOTATION'; annotation: Annotation }
  | { type: 'REMOVE_ANNOTATION'; id: string }
  | { type: 'FOCUS_ANNOTATION'; id: string }
  | { type: 'START_PICK'; requestId: string }
  | { type: 'CANCEL_PICK' }
  | { type: 'GET_PAGE_CONTEXT' }
  | { type: 'COLLECT_PAGE_CONTEXT'; requestId: string }
  | { type: 'PROBE_FRAME'; requestId: string; selectors: string[] }
  | { type: 'GET_AUTOMATION_STATUS' }
  | { type: 'RUN_AUTOMATION'; runId: string; steps: AutomationStep[] }
  | { type: 'CANCEL_AUTOMATION' }
  | { type: 'PREVIEW_STEPS'; key: string; steps: AutomationStep[] }
  | { type: 'CLEAR_PREVIEW' }

/** 内容脚本 -> 侧边栏 */
export type FromContentMessage =
  | { type: 'CONTENT_READY' }
  | { type: 'SELECTION_CHANGED'; text: string }
  | { type: 'ANNOTATION_CLICKED'; id: string }
  | { type: 'PICKED'; requestId: string; selector: string; tag: string; text: string }
  | { type: 'PICK_CANCELED'; requestId: string }
  | { type: 'FRAME_CONTEXT'; requestId: string; context: PageContext }
  | { type: 'FRAME_PROBE'; requestId: string; matched: number; total: number }
  | { type: 'AUTOMATION_LOG'; runId: string; level: AutomationLogLevel; message: string }
  | { type: 'AUTOMATION_RESULT'; runId: string; data: ExtractResult[] }
  | { type: 'AUTOMATION_DONE'; runId: string; ok: boolean }

export interface ContentResponse {
  ok?: boolean
  message?: string
  /** CANCEL_AUTOMATION 的回执：内容脚本是否仍有流程在跑 */
  running?: boolean
  /** PREVIEW_STEPS 的回执：当前是否仍处于标注状态 */
  previewing?: boolean
  /** PREVIEW_STEPS 的回执：实际标注的元素数量 */
  matched?: number
  /** GET_PAGE_CONTEXT 的回执：页面元素摘要 */
  context?: PageContext
}

export interface CreateAnnotationResponse extends ContentResponse {
  anchor?: AnnotationAnchor
}

export interface SelectionResponse {
  text?: string
}

export const STORAGE_ANNOTATIONS = 'mr_annotations'
export const STORAGE_AUTOMATION = 'mr_automation_steps'
export const STORAGE_WORKFLOWS = 'mr_workflows'
export const STORAGE_AI_SETTINGS = 'mr_ai_settings'

/** 同一页面内进行比较的 key（忽略 hash） */
export function pageKey(url: string): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}${parsed.search}`
  } catch {
    return url.split('#')[0]
  }
}

/** 网站级 key（协议 + 主机 + 端口）；无法解析时返回空字符串 */
export function siteOrigin(url: string): string {
  if (!url) return ''
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? '' : origin
  } catch {
    return ''
  }
}
