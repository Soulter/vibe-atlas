# Vibe Atlas

Vibe Atlas 是一个 Electron 多终端工作台：你可以在一个可平移的画布中创建、编排和管理多个可拖拽的终端窗口，用它们并行进行批量的 vibe coding。

## 运行

```bash
npm install
npm start
```

## 使用方式

- 左键点击顶部工具栏中的“添加 Terminal”可新增一个终端窗口。
- 左键拖拽空白画布区域可移动画布。
- 左键拖拽终端窗口顶部可调整其在画布中的位置。
- 点击红色圆点按钮可关闭对应终端窗口。

## 常见问题

- 如果“创建终端失败：posix_spawnp failed”：
  - 先确认机器中存在可用 shell（如 `/bin/bash`、`/bin/zsh`）。
  - 可用环境变量指定启动 shell：`CANVAS_SHELL=/bin/bash npm start`。

## 目录

- `main.js`：Electron 主进程（窗口管理、pty 生命周期）
- `renderer.js`：画布交互与终端组件（拖拽、输入输出）
- `index.html`：基础页面
- `styles.css`：界面样式
