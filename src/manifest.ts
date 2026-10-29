import { defineManifest } from '@crxjs/vite-plugin'
import packageData from '../package.json'

//@ts-ignore
const isDev = process.env.NODE_ENV == 'development'

export default defineManifest({
  name: `${packageData.displayName || packageData.name}${isDev ? ` ➡️ Dev` : ''}`,
  description: packageData.description,
  version: packageData.version,
  manifest_version: 3,
  icons: {
    16: 'img/logo-16.png',
    32: 'img/logo-32.png',
    48: 'img/logo-48.png',
    128: 'img/logo-128.png',
  },
  action: {
    default_title: '打开 mindRepetition 侧边栏',
    default_icon: 'img/logo-128.png',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/contentScript/index.ts'],
      // 管理后台等功能页通常在 iframe 中，需要同时注入子 frame
      all_frames: true,
      // 兼容通过 about:blank iframe 承载内容的旧系统
      match_about_blank: true,
    },
  ],
  // 侧边栏
  side_panel: {
    default_path: 'sidepanel.html',
  },
  // scripting：页面在扩展加载/重载前打开时，侧边栏会补注入内容脚本
  permissions: ['sidePanel', 'storage', 'tabs', 'scripting'],
  host_permissions: ['http://*/*', 'https://*/*'],
})
