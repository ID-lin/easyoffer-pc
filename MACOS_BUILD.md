# macOS 客户端构建与发布

macOS 的 `.app` / `.dmg` **只能在 macOS 上构建**。electron-builder 在 Windows 上会直接报错：

```
Build for macOS is supported only on macOS
```

当前配置已经准备好：

- 应用名：`EasyOffer`
- 架构：`arm64`（Apple Silicon，M1/M2/M3/M4）和 `x64`（Intel）各一份
- 产物：`dist/EasyOffer-<版本>-arm64.dmg`、`dist/EasyOffer-<版本>-x64.dmg`，以及对应的 `.zip`
- 最低系统版本：macOS 13（系统音频回环依赖 ScreenCaptureKit）
- 默认连接：`ws://182.92.231.51/ws/device`
- 未签名（没有 Apple Developer 证书）

---

## 方案 A：有一台 Mac（最快）

在 Mac 上进入项目目录，执行：

```bash
cd pc-electron
npm ci
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac
```

`build:mac` 会同时打 arm64 和 x64。完成后 `dist/` 下会有：

```
EasyOffer-1.0.0-arm64.dmg
EasyOffer-1.0.0-x64.dmg
EasyOffer-1.0.0-arm64-mac.zip
EasyOffer-1.0.0-x64-mac.zip
```

只打某一种架构可以临时用：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --publish never
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --x64 --publish never
```

---

## 方案 B：没有 Mac，用 GitHub Actions

仓库里已经放好 `.github/workflows/build-macos.yml`。需要把 `pc-electron` 放到 GitHub（私有仓库也可以）：

```bash
cd pc-electron
git remote add github https://github.com/<你的账号>/pc-electron.git
git push github master
```

然后：

1. 打开 GitHub 仓库 → **Actions** → **Build macOS** → **Run workflow**。
2. 等 5–10 分钟，进入这次运行，下载 **EasyOffer-macOS** artifact。
3. 解压后得到 dmg/zip 文件，按下面的步骤上传到服务器。

> 免费额度：私有仓库每月 2,000 分钟，macOS runner 按 10 倍计费，约够 20 次构建；公开仓库的标准 runner 免费。

---

## 上传到服务器并提供下载 URL

```bash
scp -i "C:/Users/孤木不成林/.ssh/easyoffer_deploy" \
    -o UserKnownHostsFile=/c/Users/Public/easyoffer_known_hosts \
    dist/EasyOffer-1.0.0-arm64.dmg \
    dist/EasyOffer-1.0.0-x64.dmg \
    root@182.92.231.51:/var/www/easyoffer/downloads/
```

在服务器上建立固定下载名，以后换版本只替换文件、链接不变：

```bash
ssh -i "C:/Users/孤木不成林/.ssh/easyoffer_deploy" \
    -o UserKnownHostsFile=/c/Users/Public/easyoffer_known_hosts \
    root@182.92.231.51 \
    "cd /var/www/easyoffer/downloads && \
     cp -f EasyOffer-1.0.0-arm64.dmg EasyOffer-mac-arm64.dmg && \
     cp -f EasyOffer-1.0.0-x64.dmg EasyOffer-mac-x64.dmg && \
     chmod 644 *.dmg"
```

最终下载地址：

- Apple Silicon（M 系列）：`http://182.92.231.51/downloads/EasyOffer-mac-arm64.dmg`
- Intel Mac：`http://182.92.231.51/downloads/EasyOffer-mac-x64.dmg`

---

## 用户首次打开未签名 App

因为没有 Apple Developer 签名，macOS 会提示“无法验证开发者”。让用户这样操作：

1. 打开 DMG，把 EasyOffer 拖进「应用程序」。
2. 在「应用程序」里 **右键 EasyOffer → 打开 → 打开**（不要直接双击）。
3. 如果仍被拦截：系统设置 → 隐私与安全性 → 页面底部点「仍要打开」。
4. 首次使用时授予：
   - **麦克风**权限（采集你的回答）
   - **屏幕录制**权限（采集面试官的系统声音）
5. 授予屏幕录制权限后，通常需要退出 App 再重新打开才会生效。

> 如果用户熟悉终端，也可以执行 `xattr -cr /Applications/EasyOffer.app` 清除隔离属性。

---

## 关于签名与公证（可选）

要做到用户双击直接打开、不出现安全提示，需要：

1. 加入 Apple Developer Program（99 美元/年）。
2. 创建 **Developer ID Application** 证书。
3. 在 `electron-builder.yml` 中把 `mac.notarize` 改为 `true`，并配置公证凭据（`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，或 App Store Connect API Key）。
4. 重新构建并上传。

在拿到证书之前，未签名 DMG 可以正常使用，只是首次打开多两步操作。

---

## 每次发新版本

1. 修改 `package.json` 的 `version`（如 `1.0.0` → `1.0.1`）。
2. 在 Mac 或 GitHub Actions 上重新构建。
3. 上传新版本 dmg，并在服务器上把固定名 `EasyOffer-mac-arm64.dmg` / `EasyOffer-mac-x64.dmg` 指向新文件。
4. Windows 安装包同样处理，固定名 `EasyOffer-Setup.exe`。
