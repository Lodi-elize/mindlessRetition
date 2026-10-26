import type { ToContentMessage } from '../shared/types'

/**
 * 向标签页发送消息。
 * 不传 frameId 时 Chrome 会把消息广播到该标签页的所有 frame；
 * 需要精确控制执行位置时必须传 frameId。
 */
export function sendToTab<T = unknown>(
  tabId: number,
  message: ToContentMessage,
  frameId?: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const callback = (response: T) => {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message ?? '无法连接当前页面'))
      else resolve(response)
    }

    if (frameId == null) chrome.tabs.sendMessage(tabId, message, callback)
    else chrome.tabs.sendMessage(tabId, message, { frameId }, callback)
  })
}

export function getStorage<T>(keys: string): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result as T))
  })
}

export function setStorage(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message ?? '写入本地存储失败'))
      else resolve()
    })
  })
}

export function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] ?? null))
  })
}
