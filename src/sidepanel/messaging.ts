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
  return new Promise((resolve, reject) => {
    // 直接访问 Vite 调试地址时没有扩展 API，抛错好让侧边栏给出明确提示
    if (!chrome.tabs?.query) {
      reject(new Error('当前页面没有扩展 API，请从浏览器工具栏打开侧边栏'))
      return
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] ?? null))
  })
}

/**
 * 页面在扩展加载/重载之前就已打开时，Chrome 不会补注入内容脚本。
 * 这里按 manifest 声明的脚本文件手动注入一次，让侧边栏自愈（不需要用户刷新页面）。
 */
export async function ensureContentScript(tabId: number): Promise<boolean> {
  const files = (chrome.runtime.getManifest().content_scripts ?? []).flatMap(
    (entry) => entry.js ?? [],
  )
  if (!files.length || !chrome.scripting?.executeScript) return false

  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files })
    return true
  } catch {
    // 个别子 frame 受限时会整体失败，至少补上主 frame
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files })
      return true
    } catch {
      return false
    }
  }
}
