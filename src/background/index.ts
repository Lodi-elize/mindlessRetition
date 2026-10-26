// 点击扩展图标直接打开侧边栏（而不是弹窗）
function enableSidePanelOnActionClick() {
  chrome.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => console.warn('无法设置侧边栏打开方式', error))
}

enableSidePanelOnActionClick()
chrome.runtime.onInstalled.addListener(enableSidePanelOnActionClick)
chrome.runtime.onStartup.addListener(enableSidePanelOnActionClick)
