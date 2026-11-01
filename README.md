# pc-electron

EasyOffer 桌面端音频面板（Electron + Vue 3 + electron-vite）。

## 功能

- 麦克风设备枚举、切换与实时音量条
- 系统音频采集（Electron loopback，Windows / macOS 13+）
- 音频面板 / 设置两个标签页

## 开发

```bash
npm install
npm run dev
```

## 打包

```bash
npm run build:win     # Windows
npm run build:mac     # macOS
npm run build:linux   # Linux
```
