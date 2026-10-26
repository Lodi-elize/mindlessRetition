# 无聊的重复

> 本浏览器插件借助 AI 解析对话指令，识别页面元素，自动在网页上执行一系列操作。
无需预先录制固定步骤，你可以用自然语言告知 AI 你的目标。它会分析当前页面、定位按钮与输入框，自动完成点击、填写、查询等交互任务。旨在消除枯燥重复的网页操作，提升日常工作流效率。

## 安装

1. 检查你的 Node.js 版本是否 ≥ 14
2. 在 `src/manifest` 文件中修改或配置插件名称
3. 执行 `npm install` 安装依赖

## 开发调试

run the command

```shell
$ cd my-react-ext

$ npm run dev
```

### Chrome 插件开发者模式

1. 开启 Chrome 浏览器的「开发者模式」
2. 点击「加载已解压的扩展程序」，选择 `my-react-ext/build` 文件夹


## Packing

开发完成后执行命令：

```shell
$ npm run build
```

此时 `build` 目录内的文件就是可提交到 Chrome 网上应用店的插件包。你可以查看[官方文档](https://developer.chrome.com/webstore/publish)，了解更多发布相关信息。

---

由 [create-chrome-ext](https://github.com/guocaoyi/create-chrome-ext) 脚手架生成

