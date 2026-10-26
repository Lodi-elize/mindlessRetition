export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequestOptions {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
}

export class AiRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiRequestError'
  }
}

const TIMEOUT_MS = 90_000

/** 判断主机名是否为本机 / 局域网地址（不含端口） */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '[::1]' || host === '127.0.0.1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
}

function hostnameOf(raw: string): string {
  const withoutScheme = raw.replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
  const hostPort = withoutScheme.split(/[/?#]/)[0] ?? ''
  const afterUser = hostPort.replace(/^.*@/, '')
  // [::1]:11434 / 127.0.0.1:11434
  return afterUser.replace(/:\d+$/, '')
}

/** 缺少协议时补全：本地地址默认 http，其余默认 https */
export function withProtocol(baseUrl: string): string {
  const raw = baseUrl.trim()
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) return raw
  return `${isLocalHostname(hostnameOf(raw)) ? 'http' : 'https'}://${raw}`
}

/** 把用户填写的 Base URL 规整成 /chat/completions 地址 */
export function chatCompletionsUrl(baseUrl: string): string {
  const raw = baseUrl.trim()
  if (!raw) throw new AiRequestError('请先填写 Base URL')

  let url: URL
  try {
    url = new URL(withProtocol(raw))
  } catch {
    throw new AiRequestError('Base URL 格式不正确')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AiRequestError('Base URL 必须以 http:// 或 https:// 开头')
  }

  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = /\/chat\/completions$/.test(path)
    ? path
    : path
      ? `${path}/chat/completions`
      : '/v1/chat/completions'

  return url.toString()
}

function statusMessage(status: number, detail: string): string {
  const suffix = detail ? `：${detail}` : ''
  switch (status) {
    case 400:
      return `请求被拒绝（400）${suffix}`
    case 401:
      return 'API Key 无效或已过期（401），请检查「设置」中的 Key。'
    case 403:
      return `没有访问权限（403）${suffix || '，请检查 Key 或账号状态。'}`
    case 404:
      return '接口地址不存在（404），请检查 Base URL（通常以 /v1 结尾）。'
    case 429:
      return '请求太频繁或额度不足（429），请稍后重试。'
    default:
      if (status >= 500) return `模型服务暂时不可用（HTTP ${status}），请稍后重试。`
      return `请求失败（HTTP ${status}）${suffix}`
  }
}

function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as {
      error?: { message?: unknown }
      message?: unknown
    }
    const message = data?.error?.message ?? data?.message
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300)
  } catch {
    /* 非 JSON 响应，直接截取原文 */
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function contentFromResponse(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null

  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices) || !choices.length) return null

  const message = (choices[0] as { message?: { content?: unknown } })?.message
  const content = message?.content

  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .filter(Boolean)
    return parts.length ? parts.join('\n') : null
  }

  return null
}

export async function requestChatCompletion(options: ChatRequestOptions): Promise<string> {
  const endpoint = chatCompletionsUrl(options.baseUrl)
  const model = options.model.trim()
  if (!model) throw new AiRequestError('请先在「设置」中填写模型名称')

  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, TIMEOUT_MS)

  const cancel = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', cancel)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = options.apiKey.trim()
  // 本地服务通常不需要 Key，避免发送空的 Authorization 头
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  try {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        // 只发送最小字段集：部分 OpenAI 兼容服务会拒绝 response_format / temperature
        body: JSON.stringify({ model, messages: options.messages, stream: false }),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AiRequestError(
          timedOut ? '请求超时（90 秒），请重试。' : '已取消生成',
        )
      }
      let host = endpoint
      try {
        host = new URL(endpoint).host
      } catch {
        /* 保留完整地址 */
      }
      const reason = (error as Error).message
      throw new AiRequestError(
        `无法连接到 ${host}，请检查地址、网络或本地服务是否已启动${reason ? `（${reason}）` : ''}`,
      )
    }

    const body = await response.text()

    if (!response.ok) {
      throw new AiRequestError(statusMessage(response.status, errorDetail(body)))
    }

    let data: unknown
    try {
      data = JSON.parse(body)
    } catch {
      throw new AiRequestError(
        '服务返回了非 JSON 内容，请确认 Base URL 指向 OpenAI 兼容接口。',
      )
    }

    const content = contentFromResponse(data)
    if (content == null) {
      throw new AiRequestError('响应格式异常：未找到 choices[0].message.content。')
    }
    if (!content.trim()) {
      throw new AiRequestError('模型返回了空内容，请重试或更换模型。')
    }

    return content
  } finally {
    window.clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
  }
}
