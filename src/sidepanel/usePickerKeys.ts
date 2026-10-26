import { useEffect } from 'react'

import { sendToTab } from './messaging'

/**
 * 点选时焦点通常还在侧边栏，这里把 Esc 转发给页面里的选择器以便退出点选。
 * 页面自身获得焦点时由内容脚本直接处理，不会重复触发。
 */
export function usePickerKeys(
  active: boolean,
  tabId: number | null,
  onCancel: () => void,
) {
  useEffect(() => {
    if (!active || tabId == null) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.altKey || event.ctrlKey || event.metaKey) return

      event.preventDefault()
      void sendToTab(tabId, { type: 'CANCEL_PICK' }).catch(() => undefined)
      onCancel()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, tabId, onCancel])
}
