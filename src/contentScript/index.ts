import type {
  ContentResponse,
  FromContentMessage,
  SelectionResponse,
  ToContentMessage,
} from '../shared/types'
import {
  createAnnotation,
  focusAnnotation,
  getSelectionText,
  initAnnotations,
  removeHighlight,
} from './annotations'
import { cancelAutomation, isAutomationRunning, runAutomation } from './automation'
import { initElementMarks } from './elementMarks'
import { collectPageContext } from './pageContext'
import { cancelPicker, initPicker, startPicker } from './picker'
import { clearPreview, previewSteps } from './preview'

function sendToSidePanel(message: FromContentMessage) {
  try {
    chrome.runtime.sendMessage(message, () => {
      // 侧边栏未打开时会没有接收方，忽略该错误即可
      void chrome.runtime.lastError
    })
  } catch {
    /* 扩展上下文失效时忽略 */
  }
}

function initContentScript() {
  initAnnotations(sendToSidePanel)
  initPicker(sendToSidePanel)
  initElementMarks(sendToSidePanel)

  // 通知已打开的侧边栏重新做一次连接探测。
  // 页面刷新后 tabs.onUpdated(complete) 可能早于内容脚本注入，只靠侧边栏轮询会一直显示未连接。
  sendToSidePanel({ type: 'CONTENT_READY' })

  chrome.runtime.onMessage.addListener(handleMessage)
}

function handleMessage(
  message: ToContentMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: ContentResponse | SelectionResponse) => void,
) {
  try {
    switch (message.type) {
      case 'PING':
        sendResponse({ ok: true })
        break

      case 'GET_SELECTION':
        sendResponse({ ok: true, text: getSelectionText() })
        break

      case 'CREATE_ANNOTATION':
        sendResponse(createAnnotation(message.annotation))
        break

      case 'REMOVE_ANNOTATION':
        removeHighlight(message.id)
        sendResponse({ ok: true })
        break

      case 'FOCUS_ANNOTATION':
        focusAnnotation(message.id)
        sendResponse({ ok: true })
        break

      case 'START_PICK':
        clearPreview()
        startPicker(message.requestId)
        sendResponse({ ok: true })
        break

      case 'CANCEL_PICK':
        cancelPicker()
        sendResponse({ ok: true })
        break

      case 'GET_PAGE_CONTEXT':
        if (isAutomationRunning()) {
          sendResponse({ ok: false, message: '流程执行中，暂时无法读取页面' })
          break
        }
        sendResponse({ ok: true, context: collectPageContext() })
        break

      case 'COLLECT_PAGE_CONTEXT':
        if (isAutomationRunning()) {
          sendResponse({ ok: false, message: '流程执行中，暂时无法读取页面' })
          break
        }
        // 每个 frame 各自回复，侧边栏按 sender.frameId 汇总
        sendResponse({ ok: true })
        sendToSidePanel({
          type: 'FRAME_CONTEXT',
          requestId: message.requestId,
          context: collectPageContext(),
        })
        break

      case 'PROBE_FRAME': {
        const selectors = message.selectors.filter(Boolean)
        let matched = 0
        for (const selector of selectors) {
          try {
            if (document.querySelectorAll(selector).length) matched += 1
          } catch {
            /* 非法选择器不计入 */
          }
        }
        sendResponse({ ok: true })
        sendToSidePanel({
          type: 'FRAME_PROBE',
          requestId: message.requestId,
          matched,
          total: selectors.length,
        })
        break
      }

      case 'GET_AUTOMATION_STATUS':
        sendResponse({ ok: true, running: isAutomationRunning() })
        break

      case 'RUN_AUTOMATION':
        if (isAutomationRunning()) {
          sendResponse({ ok: false, message: '已有流程正在执行' })
          break
        }
        clearPreview()
        sendResponse({ ok: true })
        void runAutomation(message.steps, {
          log: (level, text) =>
            sendToSidePanel({
              type: 'AUTOMATION_LOG',
              runId: message.runId,
              level,
              message: text,
            }),
          result: (data) =>
            sendToSidePanel({ type: 'AUTOMATION_RESULT', runId: message.runId, data }),
          done: (ok) => sendToSidePanel({ type: 'AUTOMATION_DONE', runId: message.runId, ok }),
        })
        break

      case 'CANCEL_AUTOMATION':
        cancelAutomation()
        sendResponse({ ok: true, running: isAutomationRunning() })
        break

      case 'PREVIEW_STEPS': {
        const result = previewSteps(message.key, message.steps)
        sendResponse({
          ok: true,
          previewing: result.active,
          matched: result.matched,
          message: result.message,
        })
        break
      }

      case 'CLEAR_PREVIEW':
        clearPreview()
        sendResponse({ ok: true, previewing: false })
        break

      default:
        sendResponse({ ok: false, message: '未知指令' })
    }
  } catch (error) {
    sendResponse({ ok: false, message: (error as Error).message })
  }

  // 所有分支都同步调用 sendResponse
  return false
}

// 侧边栏在内容脚本缺失时（页面在扩展加载/重载前就已打开）会补注入同一个文件。
// 用标记保证每个 frame 只初始化一次，避免重复注册监听器和标记层。
const injectedFlag = '__mindRepetitionContentScriptReady'
const scope = window as unknown as Record<string, boolean | undefined>

if (!scope[injectedFlag]) {
  scope[injectedFlag] = true
  initContentScript()
}
