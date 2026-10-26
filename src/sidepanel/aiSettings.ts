import { STORAGE_AI_SETTINGS, type AiPreset, type AiSettings } from '../shared/types'
import { isLocalHostname, withProtocol } from './aiClient'
import { getStorage, setStorage } from './messaging'

interface PresetDefinition {
  label: string
  baseUrl: string
  model: string
}

export const AI_PRESETS: Record<Exclude<AiPreset, 'custom'>, PresetDefinition> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  kimi: {
    label: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
  },
  qwen: {
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  ollama: {
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5',
  },
}

export const PRESET_OPTIONS: { value: AiPreset; label: string }[] = [
  ...(Object.keys(AI_PRESETS) as Exclude<AiPreset, 'custom'>[]).map((value) => ({
    value,
    label: AI_PRESETS[value].label,
  })),
  { value: 'custom', label: '自定义接口' },
]

export const DEFAULT_AI_SETTINGS: AiSettings = {
  preset: 'deepseek',
  baseUrl: AI_PRESETS.deepseek.baseUrl,
  model: AI_PRESETS.deepseek.model,
  apiKey: '',
}

function isPreset(value: unknown): value is AiPreset {
  return typeof value === 'string' && PRESET_OPTIONS.some((option) => option.value === value)
}

export function normalizeAiSettings(raw: unknown): AiSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AI_SETTINGS }

  const record = raw as Record<string, unknown>
  const preset = isPreset(record.preset) ? record.preset : DEFAULT_AI_SETTINGS.preset

  const baseUrl =
    typeof record.baseUrl === 'string' && record.baseUrl.trim()
      ? record.baseUrl.trim()
      : preset === 'custom'
        ? ''
        : AI_PRESETS[preset as Exclude<AiPreset, 'custom'>].baseUrl

  const model =
    typeof record.model === 'string' && record.model.trim()
      ? record.model.trim()
      : preset === 'custom'
        ? ''
        : AI_PRESETS[preset as Exclude<AiPreset, 'custom'>].model

  return {
    preset,
    baseUrl,
    model,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
    ...(typeof record.lastPrompt === 'string' && record.lastPrompt
      ? { lastPrompt: record.lastPrompt }
      : {}),
  }
}

/**
 * 切换预设时填充 Base URL 与模型。
 * 切换到不同的服务商时清空 API Key，避免把上一家的 Key 发到新地址。
 */
export function applyPreset(preset: AiPreset, current: AiSettings): AiSettings {
  const changedProvider = preset !== current.preset

  if (preset === 'custom') {
    return { ...current, preset, ...(changedProvider ? { apiKey: '' } : {}) }
  }

  const definition = AI_PRESETS[preset]
  return {
    ...current,
    preset,
    baseUrl: definition.baseUrl,
    model: definition.model,
    ...(changedProvider ? { apiKey: '' } : {}),
  }
}

export async function loadAiSettings(): Promise<AiSettings> {
  const data = await getStorage<Record<string, unknown>>(STORAGE_AI_SETTINGS)
  return normalizeAiSettings(data[STORAGE_AI_SETTINGS])
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await setStorage({ [STORAGE_AI_SETTINGS]: settings })
}

/** 本地 / 局域网服务通常不校验 Key（Ollama、LM Studio 等） */
export function isLocalEndpoint(baseUrl: string): boolean {
  if (!baseUrl.trim()) return true
  try {
    return isLocalHostname(new URL(withProtocol(baseUrl)).hostname)
  } catch {
    return false
  }
}
