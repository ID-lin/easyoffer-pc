<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const activeTab = ref('audio')
const micDevices = ref([])
const displaySources = ref([])
const micId = ref('')
const systemId = ref('')
const micLevel = ref(0)
const systemLevel = ref(0)
const micConnected = ref(false)
const systemConnected = ref(false)
const toastText = ref('')
const settings = ref({
  clipboardMonitor: true,
  trayEnabled: true,
  screenshotShortcut: 'CommandOrControl+Shift+Space'
})
const recordingShortcut = ref(false)

const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space'

let toastTimer = null
let micStream = null
let systemStream = null
let micMeter = null
let systemMeter = null
let offClipboard = null
let offScreenshot = null

// 已连接的额外设备数量，未点击「连接设备」前保持 0
const pairedDeviceCount = ref(0)

/* ---------------- 连接新设备弹窗 ---------------- */
const showPairDialog = ref(false)
const pairing = ref(false)
const pairCode = ref(['', '', '', '', '', ''])
const pairInputs = ref([])

function setPairInput(index, el) {
  if (el) pairInputs.value[index] = el
}

function openPairDialog() {
  if (showPairDialog.value) return
  pairCode.value = ['', '', '', '', '', '']
  showPairDialog.value = true
  nextTick(() => pairInputs.value[0]?.focus())
}

function closePairDialog() {
  if (pairing.value) return
  showPairDialog.value = false
}

function fillPairCode(digits, startIndex = 0) {
  digits.split('').forEach((digit, offset) => {
    const index = startIndex + offset
    if (index < 6) pairCode.value[index] = digit
  })
  const focusIndex = Math.min(startIndex + digits.length, 5)
  nextTick(() => pairInputs.value[focusIndex]?.focus())
}

function onCodeInput(index, event) {
  const digits = event.target.value.replace(/\D/g, '')
  if (digits.length > 1) {
    fillPairCode(digits, index)
    return
  }
  pairCode.value[index] = digits
  event.target.value = digits
  if (digits && index < 5) pairInputs.value[index + 1]?.focus()
}

function onCodeKeydown(index, event) {
  if (event.key === 'Backspace' && !pairCode.value[index] && index > 0) {
    pairInputs.value[index - 1]?.focus()
    pairCode.value[index - 1] = ''
  } else if (event.key === 'Enter') {
    submitPair()
  }
}

function onCodePaste(event) {
  const digits = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
  if (!digits) return
  event.preventDefault()
  fillPairCode(digits)
}

async function submitPair() {
  const code = pairCode.value.join('')
  if (code.length !== 6) {
    showToast('请输入完整的 6 位配对码')
    return
  }
  pairing.value = true
  // TODO: 接入真实的配对接口，这里先模拟校验
  await new Promise((resolve) => setTimeout(resolve, 500))
  pairing.value = false
  showPairDialog.value = false
  pairedDeviceCount.value += 1
  showToast('设备连接成功')
}

function showToast(text) {
  toastText.value = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastText.value = ''), 2200)
}

/**
 * 创建音量分析器，把音频流的实时音量写入 levelRef（0 ~ 1）
 */
function createMeter(stream, levelRef) {
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.6
  source.connect(analyser)
  const data = new Uint8Array(analyser.fftSize)
  let raf = 0
  let smoothed = 0

  const tick = () => {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    const db = 20 * Math.log10(rms || 1e-5)
    const target = Math.min(1, Math.max(0, (db + 60) / 60))
    smoothed = smoothed * 0.7 + target * 0.3
    levelRef.value = smoothed
    raf = requestAnimationFrame(tick)
  }

  ctx.resume?.()
  tick()

  return {
    stop() {
      cancelAnimationFrame(raf)
      levelRef.value = 0
      source.disconnect()
      ctx.close()
    }
  }
}

async function applyMicStream(stream) {
  const tracks = stream.getAudioTracks()
  if (!tracks.length) {
    stream.getTracks().forEach((t) => t.stop())
    showToast('未获取到麦克风音频')
    return
  }
  micStream = stream
  const settings = tracks[0].getSettings()
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === 'audioinput'
  )
  micDevices.value = devices
  if (settings.deviceId) micId.value = settings.deviceId
  micMeter = createMeter(stream, micLevel)
  micConnected.value = true
}

function stopMic() {
  micMeter?.stop()
  micMeter = null
  micStream?.getTracks().forEach((t) => t.stop())
  micStream = null
  micConnected.value = false
}

// 重新获取麦克风列表，并默认使用系统默认麦克风
async function refreshMic() {
  stopMic()
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    await applyMicStream(stream)
  } catch (error) {
    micDevices.value = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'audioinput'
    )
    micId.value = micDevices.value[0]?.deviceId || ''
    showToast('未检测到可用麦克风')
    console.error(error)
  }
}

async function onMicChange() {
  stopMic()
  if (!micId.value) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: micId.value } }
    })
    await applyMicStream(stream)
  } catch (error) {
    showToast('切换麦克风失败：' + error.message)
  }
}

function stopSystem() {
  systemMeter?.stop()
  systemMeter = null
  systemStream?.getTracks().forEach((t) => t.stop())
  systemStream = null
  systemConnected.value = false
}

async function loadDisplaySources() {
  try {
    const sources = await window.api.getDisplaySources()
    displaySources.value = sources
    if (!sources.some((s) => s.id === systemId.value)) {
      systemId.value = sources[0]?.id || ''
    }
  } catch (error) {
    showToast('获取系统音频设备失败')
    console.error(error)
  }
}

// 采集系统播放的声音（Windows / macOS 13+ 走 loopback）
async function onSystemChange() {
  stopSystem()
  if (!systemId.value) return
  window.api.setDisplaySource(systemId.value)
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    })
    const audioTracks = stream.getAudioTracks()
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop())
      showToast('未捕获到系统声音，请确认当前有音频正在播放')
      return
    }
    // 只保留音频，画面轨静音但保持存活，避免部分平台连带停止音频
    stream.getVideoTracks().forEach((t) => (t.enabled = false))
    audioTracks[0].addEventListener('ended', stopSystem)
    systemStream = stream
    systemMeter = createMeter(new MediaStream(audioTracks), systemLevel)
    systemConnected.value = true
  } catch (error) {
    if (error.name !== 'AbortError') {
      showToast('系统音频捕获失败：' + error.message)
    }
    console.error(error)
  }
}

async function refreshSystem() {
  await loadDisplaySources()
  await onSystemChange()
}

function openSite() {
  window.api.openExternal('https://www.electronjs.org')
}

/* ---------------- 设置 ---------------- */

const shortcutKeys = computed(() =>
  settings.value.screenshotShortcut.split('+').map((key) => {
    if (key === 'CommandOrControl' || key === 'CmdOrCtrl') {
      return window.api.platform === 'darwin' ? '⌘' : 'Ctrl'
    }
    if (key === 'Alt') return window.api.platform === 'darwin' ? '⌥' : 'Alt'
    if (key === 'Space') return 'Space'
    return key.length === 1 ? key.toUpperCase() : key
  })
)

async function updateSetting(key, value) {
  const result = await window.api.setSettings({ [key]: value })
  if (!result.ok) {
    showToast(result.message)
    return
  }
  settings.value = result.settings
}

function normalizeKey(event) {
  const { code, key } = event
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  const map = {
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
  }
  if (map[code]) return map[code]
  return key.length === 1 ? key.toUpperCase() : null
}

function onShortcutKeydown(event) {
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') {
    stopRecordingShortcut()
    return
  }
  const key = normalizeKey(event)
  if (!key) return
  const modifiers = []
  if (event.ctrlKey || event.metaKey) modifiers.push('CommandOrControl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (!modifiers.length) {
    showToast('快捷键需要包含 Ctrl / Alt / Shift 中的至少一个')
    return
  }
  stopRecordingShortcut()
  saveShortcut([...modifiers, key].join('+'))
}

function startRecordingShortcut() {
  if (recordingShortcut.value) return
  recordingShortcut.value = true
  window.addEventListener('keydown', onShortcutKeydown, true)
}

function stopRecordingShortcut() {
  recordingShortcut.value = false
  window.removeEventListener('keydown', onShortcutKeydown, true)
}

async function saveShortcut(accelerator) {
  const result = await window.api.setSettings({ screenshotShortcut: accelerator })
  if (!result.ok) {
    showToast(result.message)
    return
  }
  settings.value = result.settings
  showToast('截屏快捷键已更新')
}

function resetShortcut() {
  if (settings.value.screenshotShortcut === DEFAULT_SHORTCUT) return
  saveShortcut(DEFAULT_SHORTCUT)
}

onMounted(async () => {
  refreshMic()
  loadDisplaySources()
  try {
    settings.value = await window.api.getSettings()
  } catch (error) {
    console.error(error)
  }
  offClipboard = window.api.onClipboardText((text) => {
    if (settings.value.clipboardMonitor && text) {
      const preview = text.length > 18 ? text.slice(0, 18) + '…' : text
      showToast('已监听剪贴板：' + preview)
    }
  })
  offScreenshot = window.api.onScreenshotTaken(() => showToast('截图已复制到剪贴板'))
})

onBeforeUnmount(() => {
  clearTimeout(toastTimer)
  stopMic()
  stopSystem()
  stopRecordingShortcut()
  offClipboard?.()
  offScreenshot?.()
})
</script>

<template>
  <div class="app">
    <div class="tabs">
      <button :class="{ active: activeTab === 'audio' }" @click="activeTab = 'audio'">
        音频面板
      </button>
      <button :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">
        设置
      </button>
    </div>

    <div v-if="activeTab === 'audio'" class="panel">
      <div class="row">
        <div class="row-info">
          <div class="row-title">麦克风</div>
          <div class="row-sub">用于捕获您的声音</div>
        </div>
        <div class="row-controls">
          <div class="meter" :class="{ active: micConnected }">
            <div
              class="meter-fill"
              :style="{ height: micConnected ? Math.max(10, micLevel * 100) + '%' : '0%' }"
            ></div>
          </div>
          <div class="select-wrap">
            <select v-model="micId" @change="onMicChange">
              <option v-if="!micDevices.length" value="">未检测到麦克风</option>
              <option
                v-for="(device, index) in micDevices"
                :key="device.deviceId || index"
                :value="device.deviceId"
              >
                {{ device.label || '麦克风 ' + (index + 1) }}
              </option>
            </select>
            <svg class="chevron" viewBox="0 0 24 24" fill="none">
              <path
                d="M6 9l6 6 6-6"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <button class="icon-btn" title="刷新麦克风列表" @click="refreshMic">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div class="divider"></div>

      <div class="row">
        <div class="row-info">
          <div class="row-title">系统音频</div>
          <div class="row-sub">用于捕获面试官的声音</div>
        </div>
        <div class="row-controls">
          <div class="meter" :class="{ active: systemConnected }">
            <div
              class="meter-fill"
              :style="{ height: systemConnected ? Math.max(10, systemLevel * 100) + '%' : '0%' }"
            ></div>
          </div>
          <div class="select-wrap">
            <select v-model="systemId" @change="onSystemChange">
              <option v-if="!displaySources.length" value="">未检测到显示器</option>
              <option v-for="source in displaySources" :key="source.id" :value="source.id">
                {{ source.name }}
              </option>
            </select>
            <svg class="chevron" viewBox="0 0 24 24" fill="none">
              <path
                d="M6 9l6 6 6-6"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <button class="icon-btn" title="刷新系统音频设备" @click="refreshSystem">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div class="divider"></div>

      <div class="row">
        <div class="row-info">
          <div class="row-title">连接其他设备</div>
          <div class="row-sub">已连接 {{ pairedDeviceCount }} 台设备</div>
        </div>
        <div class="row-controls">
          <button class="ghost-btn" @click="showToast('使用教程正在制作中')">使用教程</button>
          <button class="dark-btn" @click="openPairDialog">
            <span class="plus">+</span>连接设备
          </button>
        </div>
      </div>
    </div>

    <div v-else class="settings-list">
      <div class="panel setting-card">
        <div class="setting-text">
          <div class="row-title">文本复制监听</div>
          <div class="row-sub">开启后将会监听系统剪切板，笔试的时候建议开启</div>
        </div>
        <button
          class="switch"
          :class="{ on: settings.clipboardMonitor }"
          role="switch"
          :aria-checked="settings.clipboardMonitor"
          @click="updateSetting('clipboardMonitor', !settings.clipboardMonitor)"
        >
          <span class="knob"></span>
        </button>
      </div>

      <div class="panel setting-card">
        <div class="setting-text">
          <div class="row-title">
            托盘图标显示<span class="paren">(可通过 Ctrl + Shift + T 切换显示)</span>
          </div>
          <div class="row-sub">开启后将在系统托盘显示图标，关闭后可通过快捷键切换显示</div>
        </div>
        <button
          class="switch"
          :class="{ on: settings.trayEnabled }"
          role="switch"
          :aria-checked="settings.trayEnabled"
          @click="updateSetting('trayEnabled', !settings.trayEnabled)"
        >
          <span class="knob"></span>
        </button>
      </div>

      <div class="panel setting-card">
        <div class="setting-text">
          <div class="row-title">截屏快捷键</div>
          <div class="row-sub">截取当前屏幕并发送给配对设备</div>
        </div>
        <div class="shortcut-controls">
          <div
            class="shortcut-box"
            :class="{ recording: recordingShortcut }"
            title="点击后按下新的快捷键"
            @click="startRecordingShortcut"
          >
            <span v-if="recordingShortcut" class="recording-tip">请按下快捷键…</span>
            <template v-else>
              <template v-for="(key, index) in shortcutKeys" :key="key + index">
                <span v-if="index > 0" class="key-plus">+</span>
                <kbd>{{ key }}</kbd>
              </template>
            </template>
          </div>
          <button class="reset-btn" title="恢复默认快捷键" @click="resetShortcut">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div class="footer">
      <span class="copyright">EasyOffer v1.0.0</span>
      <div class="footer-links">
        <button @click="showToast('使用教程正在制作中')">使用教程</button>
        <button @click="openSite">打开官网</button>
      </div>
    </div>

    <transition name="toast">
      <div v-if="toastText" class="toast">{{ toastText }}</div>
    </transition>

    <Teleport to="body">
      <transition name="modal">
        <div
          v-if="showPairDialog"
          class="modal-mask"
          @click.self="closePairDialog"
          @keydown.esc="closePairDialog"
        >
          <div class="modal">
            <div class="modal-title">连接新设备</div>
            <div class="modal-sub">请输入网页端显示的 6 位配对码</div>

            <div class="code-row">
              <div class="code-group">
                <input
                  v-for="i in 3"
                  :key="'left-' + i"
                  :ref="(el) => setPairInput(i - 1, el)"
                  :value="pairCode[i - 1]"
                  type="text"
                  inputmode="numeric"
                  maxlength="1"
                  autocomplete="off"
                  @input="onCodeInput(i - 1, $event)"
                  @keydown="onCodeKeydown(i - 1, $event)"
                  @paste="onCodePaste"
                />
              </div>
              <span class="code-dash">-</span>
              <div class="code-group">
                <input
                  v-for="i in 3"
                  :key="'right-' + i"
                  :ref="(el) => setPairInput(i + 2, el)"
                  :value="pairCode[i + 2]"
                  type="text"
                  inputmode="numeric"
                  maxlength="1"
                  autocomplete="off"
                  @input="onCodeInput(i + 2, $event)"
                  @keydown="onCodeKeydown(i + 2, $event)"
                  @paste="onCodePaste"
                />
              </div>
            </div>

            <button class="primary-btn" :disabled="pairing" @click="submitPair">
              {{ pairing ? '连接中…' : '开始连接' }}
            </button>
            <button class="modal-link" @click="showToast('使用教程正在制作中')">
              查看使用教程
            </button>
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<style scoped>
.app {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 18px 20px 14px;
  overflow-y: auto;
}

/* 顶部标签 */
.tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  margin-bottom: 14px;
  background: #eceef1;
  border-radius: 10px;
}

.tabs button {
  flex: 1;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-size: 14px;
  color: #5c6470;
  transition: all 0.15s ease;
}

.tabs button.active {
  background: #fff;
  color: #1f2329;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(17, 24, 39, 0.08);
}

/* 主面板 */
.panel {
  background: #fff;
  border: 1px solid #eceef1;
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(17, 24, 39, 0.03);
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
}

.settings-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.setting-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
}

.setting-text {
  min-width: 0;
}

.paren {
  font-weight: 500;
}

.divider {
  height: 1px;
  margin: 0 20px;
  background: #f1f2f4;
}

.row-title {
  font-size: 15px;
  font-weight: 600;
  color: #1f2329;
}

.row-sub {
  margin-top: 4px;
  font-size: 12px;
  color: #9aa1ac;
}

.switch {
  position: relative;
  flex-shrink: 0;
  width: 44px;
  height: 26px;
  padding: 0;
  background: #d7dbe1;
  border: none;
  border-radius: 13px;
  transition: background 0.18s ease;
}

.switch.on {
  background: #2468f2;
}

.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 22px;
  height: 22px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(17, 24, 39, 0.25);
  transition: transform 0.18s ease;
}

.switch.on .knob {
  transform: translateX(18px);
}

.shortcut-controls {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

.shortcut-box {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 38px;
  min-width: 186px;
  padding: 0 14px;
  cursor: pointer;
  background: #f3f4f6;
  border: 1px solid #e6e8ec;
  border-radius: 8px;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.shortcut-box:hover {
  border-color: #dcdfe4;
}

.shortcut-box.recording {
  background: #eef0f3;
  border-color: #b9bfc8;
}

.shortcut-box kbd {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  font-family: inherit;
  font-size: 12px;
  color: #3a4150;
  background: #fff;
  border: 1px solid #dcdfe4;
  border-bottom-width: 2px;
  border-radius: 5px;
}

.key-plus {
  font-size: 12px;
  color: #9aa1ac;
}

.recording-tip {
  font-size: 12px;
  color: #8b939f;
}

.reset-btn {
  display: grid;
  width: 32px;
  height: 32px;
  color: #aab0b9;
  background: #f3f4f6;
  border: none;
  border-radius: 50%;
  place-items: center;
  transition:
    color 0.15s ease,
    background 0.15s ease;
}

.reset-btn svg {
  width: 14px;
  height: 14px;
}

.reset-btn:hover {
  color: #6b7280;
  background: #eceef1;
}

.row-controls {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
}

/* 音量条 */
.meter {
  display: flex;
  align-items: flex-end;
  width: 4px;
  height: 40px;
  overflow: hidden;
  background: #e6e9ed;
  border-radius: 2px;
}

.meter-fill {
  width: 100%;
  background: linear-gradient(180deg, #86e86c 0%, #34c759 100%);
  border-radius: 2px;
  transition: height 0.08s linear;
}

/* 设备下拉框 */
.select-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.select-wrap select {
  width: 208px;
  height: 38px;
  padding: 0 34px 0 12px;
  font-size: 14px;
  color: #1f2329;
  text-overflow: ellipsis;
  appearance: none;
  cursor: pointer;
  background: #fff;
  border: 1px solid #e3e6ea;
  border-radius: 8px;
  outline: none;
  transition: border-color 0.15s ease;
}

.select-wrap select:hover {
  border-color: #d3d7dd;
}

.select-wrap select:focus {
  border-color: #b9bfc8;
}

.chevron {
  position: absolute;
  right: 11px;
  width: 13px;
  height: 13px;
  color: #8b939f;
  pointer-events: none;
}

.icon-btn {
  display: grid;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  color: #4b5563;
  background: #fff;
  border: 1px solid #e3e6ea;
  border-radius: 8px;
  place-items: center;
  transition: background 0.15s ease;
}

.icon-btn svg {
  width: 16px;
  height: 16px;
}

.icon-btn:hover {
  background: #f6f7f9;
}

.icon-btn:active svg {
  transform: rotate(180deg);
  transition: transform 0.3s ease;
}

/* 按钮 */
.ghost-btn {
  height: 38px;
  padding: 0 18px;
  font-size: 14px;
  color: #1f2329;
  background: #fff;
  border: 1px solid #e3e6ea;
  border-radius: 8px;
  transition: background 0.15s ease;
}

.ghost-btn:hover {
  background: #f6f7f9;
}

.dark-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 18px;
  font-size: 14px;
  color: #fff;
  background: #2468f2;
  border: none;
  border-radius: 8px;
  transition: background 0.15s ease;
}

.dark-btn:hover {
  background: #1c56c9;
}

.plus {
  font-size: 17px;
  font-weight: 300;
  line-height: 1;
}

/* 页脚 */
.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
  padding: 14px 4px 0;
  font-size: 12px;
  color: #a0a7b2;
}

.footer-links {
  display: flex;
  gap: 18px;
}

.footer-links button {
  padding: 0;
  font-size: 12px;
  color: inherit;
  background: none;
  border: none;
  transition: color 0.15s ease;
}

.footer-links button:hover {
  color: #6b7280;
}

/* 提示 */
.toast {
  position: absolute;
  bottom: 34px;
  left: 50%;
  z-index: 200;
  padding: 8px 16px;
  font-size: 13px;
  color: #fff;
  white-space: nowrap;
  background: rgba(31, 35, 41, 0.88);
  border-radius: 8px;
  transform: translateX(-50%);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 6px);
}

/* 连接新设备弹窗 */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  background: rgba(17, 24, 39, 0.32);
  place-items: center;
}

.modal {
  width: 384px;
  padding: 28px 28px 20px;
  text-align: center;
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 18px 48px rgba(17, 24, 39, 0.18);
}

.modal-title {
  font-size: 20px;
  font-weight: 700;
  color: #1f2329;
}

.modal-sub {
  margin-top: 10px;
  font-size: 13px;
  color: #9aa1ac;
}

.code-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 24px 0 22px;
}

.code-group {
  display: flex;
  overflow: hidden;
  border: 1px solid #e3e6ea;
  border-radius: 8px;
}

.code-group input {
  width: 46px;
  height: 48px;
  padding: 0;
  font-size: 20px;
  font-weight: 600;
  color: #1f2329;
  text-align: center;
  background: #fff;
  border: none;
  border-right: 1px solid #eef0f2;
  outline: none;
  transition: background 0.15s ease;
}

.code-group input:last-child {
  border-right: none;
}

.code-group input:focus {
  background: #f5f8ff;
}

.code-dash {
  font-size: 18px;
  color: #c2c8d0;
}

.primary-btn {
  min-width: 132px;
  height: 44px;
  padding: 0 24px;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  background: #2468f2;
  border: none;
  border-radius: 8px;
  transition:
    background 0.15s ease,
    opacity 0.15s ease;
}

.primary-btn:hover {
  background: #1c56c9;
}

.primary-btn:disabled {
  cursor: default;
  opacity: 0.6;
}

.modal-link {
  display: block;
  margin: 16px auto 0;
  padding: 0;
  font-size: 13px;
  color: #8b939f;
  background: none;
  border: none;
  transition: color 0.15s ease;
}

.modal-link:hover {
  color: #2468f2;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}

.modal-enter-active .modal,
.modal-leave-active .modal {
  transition:
    transform 0.18s ease,
    opacity 0.18s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal,
.modal-leave-to .modal {
  opacity: 0;
  transform: scale(0.96);
}

@media (prefers-reduced-motion: reduce) {
  .modal-enter-active,
  .modal-leave-active,
  .modal-enter-active .modal,
  .modal-leave-active .modal {
    transition: none;
  }
}
</style>
