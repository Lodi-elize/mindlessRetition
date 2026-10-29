import { useCallback, useEffect, useState } from 'react'

import type { FromContentMessage } from '../shared/types'
import { AnnotationsTab } from './AnnotationsTab'
import { AutomationTab } from './AutomationTab'
import { ensureContentScript, queryActiveTab, sendToTab } from './messaging'
import './SidePanel.css'

type View = 'annotations' | 'automation'

export const SidePanel = () => {
  const [view, setView] = useState<View>('annotations')
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null)
  const [connected, setConnected] = useState(false)
  const [connectError, setConnectError] = useState('')

  const refresh = useCallback(async () => {
    let tab: chrome.tabs.Tab | null
    try {
      tab = await queryActiveTab()
    } catch (error) {
      setActiveTab(null)
      setConnected(false)
      setConnectError((error as Error).message)
      return
    }
    setActiveTab(tab)

    const tabId = tab?.id
    if (tabId == null) {
      setConnected(false)
      setConnectError('没有找到可用的活动标签页')
      return
    }

    const ping = () => sendToTab<{ ok?: boolean }>(tabId, { type: 'PING' })

    try {
      const response = await ping()
      setConnected(Boolean(response?.ok))
      setConnectError(response?.ok ? '' : '内容脚本无响应')
    } catch (error) {
      // 内容脚本可能根本不在这个页面里（例如页面在扩展加载/重载前就已打开），
      // 补注入后再探测一次，避免用户手动刷新页面。
      if (await ensureContentScript(tabId)) {
        try {
          const response = await ping()
          setConnected(Boolean(response?.ok))
          setConnectError(response?.ok ? '' : '内容脚本无响应')
          return
        } catch {
          /* 补注入后仍然失败，走下面的提示 */
        }
      }

      setConnected(false)
      setConnectError(`${(error as Error).message}（已尝试重新注入内容脚本）`)
    }
  }, [])

  useEffect(() => {
    void refresh()

    const handleActivated = () => void refresh()

    const handleUpdated = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (info.status === 'loading') {
        // 页面开始刷新：旧内容脚本即将失效，先标记为断开，等加载完成再重连
        void queryActiveTab().then((tab) => {
          if (tab?.id !== updatedTabId) return
          setActiveTab(tab)
          setConnected(false)
          setConnectError('')
        })
        return
      }
      void refresh()
    }

    // 侧边栏被重新打开时页面状态可能已经变化，重新探测一次
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refresh()
    }

    chrome.tabs.onActivated.addListener(handleActivated)
    chrome.tabs.onUpdated.addListener(handleUpdated)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      chrome.tabs.onActivated.removeListener(handleActivated)
      chrome.tabs.onUpdated.removeListener(handleUpdated)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [refresh])

  // 页面刷新后内容脚本重新注入完成时会发来 CONTENT_READY。
  // tabs.onUpdated(complete) 可能早于注入，没有这条消息侧边栏会一直显示「未连接」。
  useEffect(() => {
    const listener = (message: FromContentMessage, sender: chrome.runtime.MessageSender) => {
      if (message.type !== 'CONTENT_READY') return
      const senderTabId = sender.tab?.id
      if (senderTabId == null) return
      if (activeTab?.id != null && senderTabId !== activeTab.id) return
      void refresh()
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [activeTab?.id, refresh])

  const reloadPage = useCallback(async () => {
    const tab = await queryActiveTab()
    if (tab?.id == null) return
    setConnected(false)
    setConnectError('')
    try {
      await chrome.tabs.reload(tab.id)
    } catch (error) {
      setConnectError((error as Error).message)
    }
  }, [])

  const tabId = activeTab?.id ?? null
  const pageUrl = activeTab?.url ?? ''

  return (
    <div className="mr-app">
      <header className="mr-header">
        <div className="mr-brand">
          <span className="mr-logo">M</span>
          <div className="mr-brand-text">
            <span className="mr-title">mindRepetition</span>
            <span className="mr-subtitle" title={pageUrl}>
              {activeTab?.title || '未选择标签页'}
            </span>
          </div>
        </div>

        <nav className="mr-tabs" aria-label="功能切换">
          <button
            type="button"
            className={view === 'annotations' ? 'is-active' : ''}
            onClick={() => setView('annotations')}
          >
            标注
          </button>
          <button
            type="button"
            className={view === 'automation' ? 'is-active' : ''}
            onClick={() => setView('automation')}
          >
            自动化
          </button>
        </nav>
      </header>

      {!connected && (
        <div className="mr-banner">
          <p className="mr-banner-title">当前页面无法连接内容脚本</p>
          <p className="mr-banner-text">
            常见原因：扩展重新构建后未在 chrome://extensions 重新加载；页面在扩展加载前就已打开
            （侧边栏已尝试自动补注入）；当前是 chrome://、扩展页等受限页面（这类页面无法注入脚本）。
          </p>
          {connectError && <p className="mr-banner-detail">错误信息：{connectError}</p>}
          <div className="mr-banner-actions">
            <button type="button" className="mr-btn" onClick={() => void refresh()}>
              重试连接
            </button>
            <button
              type="button"
              className="mr-btn mr-btn-ghost"
              disabled={tabId == null}
              onClick={() => void reloadPage()}
            >
              刷新网页
            </button>
          </div>
        </div>
      )}

      <main className="mr-main">
        {/* 两个视图都保持挂载，切 Tab 不会丢失执行状态、日志或正在进行的点选 */}
        <div hidden={view !== 'annotations'}>
          <AnnotationsTab
            key={pageUrl || 'no-page'}
            tabId={tabId}
            pageUrl={pageUrl}
            connected={connected}
          />
        </div>
        <div hidden={view !== 'automation'}>
          <AutomationTab tabId={tabId} pageUrl={pageUrl} connected={connected} />
        </div>
      </main>
    </div>
  )
}

export default SidePanel
