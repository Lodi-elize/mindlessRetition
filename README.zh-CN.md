# mindlessRepetition（无聊的重复）

[English](README.md) · [简体中文](README.zh-CN.md)

> 本浏览器插件借助 AI 解析对话指令，识别页面元素，自动在网页上执行一系列操作。
> 无需预先录制固定步骤，你可以用自然语言告知 AI 你的目标。它会分析当前页面、定位按钮与输入框，自动完成点击、填写、查询等交互任务。旨在消除枯燥重复的网页操作，提升日常工作流效率。

## 下载

| 位置 | 内容 |
| --- | --- |
| [最新版本](https://github.com/Lodi-elize/mindlessRetition/releases/latest) | **Assets** 中的 `mindRepetition-<版本>.zip` |
| [所有版本](https://github.com/Lodi-elize/mindlessRetition/releases) | 全部已发布版本 |
| [`release` 分支](https://github.com/Lodi-elize/mindlessRetition/tree/release) | 归档目录：每个 tag 对应 `release/v<版本>/mindRepetition-<版本>.zip` |

不想打开 Releases 页面时，可以直接只拉归档分支：

```shell
$ git clone --branch release --single-branch https://github.com/Lodi-elize/mindlessRetition.git
```

### 安装下载的包

1. 解压 zip
2. 打开 `chrome://extensions`，开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择解压后的文件夹

## 功能

- 用 AI 把自然语言指令翻译成具体的页面操作
- 在当前页面定位目标元素，包括 iframe 中渲染的内容
- 自动完成点击、填写、查询，并串联多个步骤
- 支持拾取与标注元素，为 AI 提供精确的上下文
- 所有操作都可以在 Chrome 侧边栏中完成

## 环境要求

- Node.js ≥ 14
- Chrome（Manifest V3）

## 从源码安装

1. 检查你的 Node.js 版本是否 ≥ 14
2. 在 [`src/manifest.ts`](src/manifest.ts) 中修改或配置插件名称
3. 执行 `npm install`（或 `yarn`）安装依赖

## 开发调试

```shell
$ npm run dev
```

### Chrome 插件开发者模式

1. 开启 Chrome 浏览器的「开发者模式」
2. 点击「加载已解压的扩展程序」，选择 `build` 文件夹

### 重新加载扩展（重要）

`build/` 就是「加载已解压的扩展程序」所指向的目录。每次 `npm run build`（或 `npm run dev` 重新输出）之后，Chrome 里已加载的扩展仍在用旧文件，必须：

1. 打开 `chrome://extensions`，在 mindRepetition 卡片上点「重新加载」
2. 回到目标网页刷新一次（已打开的页面不会自动获得新的内容脚本）

侧边栏提示「当前页面无法连接内容脚本」时，优先按上面两步处理。`chrome://`、扩展页、Chrome 应用商店等页面本身不允许注入脚本。

注意：`npm run dev` 和 `npm run build` 都会写入 `build/`，但内容不同（dev 版依赖正在运行的 Vite 服务）。开发时保持 dev 进程运行；想要一个不依赖 dev 服务的稳定版本时，先停掉 dev，再执行 `npm run build`，然后重新加载扩展。

### 普通前端调试

1. 打开 `http://localhost:5173/`
2. 调试 popup 页面时，打开 `http://localhost:5173/popup.html`
3. 调试 options 页面时，打开 `http://localhost:5173/options.html`

## 项目结构

```
src/
├─ background/      # 后台 service worker
├─ contentScript/   # 页面自动化、元素拾取、标注
├─ sidepanel/       # 侧边栏界面、AI 客户端与工作流
├─ popup/           # 工具栏弹窗
├─ options/         # 设置页
├─ devtools/        # DevTools 面板
├─ newtab/          # 新标签页
└─ shared/          # 共用类型与步骤工具
```

## 发布（Release）

推送 `v*.*.*` 形式的 tag 后，GitHub Actions（[`.github/workflows/release.yml`](.github/workflows/release.yml)）会自动构建并发布 Release：

1. 修改 [`package.json`](package.json) 中的 `version`（插件 manifest 从这里读取版本号），并更新 [`CHANGELOG.md`](CHANGELOG.md)
2. 提交改动并推送到 `main`
3. 创建并推送对应的 tag：

```shell
$ git tag v0.1.0
$ git push origin v0.1.0
```

工作流会先校验 tag 与 `package.json` 的版本是否一致，然后构建插件、打包为 `package/<名称>-<版本>.zip`，并创建附带该 zip 的 GitHub Release。

每个版本的包同时会归档到独立的 `release` 分支，路径为 `release/v<版本>/`，不经过 Releases 页面也能拿到历史版本。该分支是孤立分支（与 `main` 没有共同历史），构建产物不会撑大 `main`，也不影响它的 clone 速度：

```shell
$ git clone --branch release --single-branch https://github.com/Lodi-elize/mindlessRetition.git
```

如果想手动发布，执行 `npm run zip`，再把 `package/*.zip` 上传到在 GitHub 页面手动创建的 Release 即可。

## 打包

开发完成后执行命令：

```shell
$ npm run build
```

此时 `build` 目录内的文件就是可提交到 Chrome 网上应用店的插件包。你可以查看[官方文档](https://developer.chrome.com/webstore/publish)，了解更多发布相关信息。

---

由 [create-chrome-ext](https://github.com/guocaoyi/create-chrome-ext) 脚手架生成
