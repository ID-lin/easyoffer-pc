<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { createPcmCapture } from './audio-capture'

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

let toastTimer = null
let levelTimer = null
let micStream = null
let systemStream = null
let micMeter = null
let systemMeter = null
/** 面试开始后，把两路音频实时上传识别 */
let micCapture = null
let systemCapture = null
let interviewActive = false
let offClipboard = null
let offScreenshot = null
let offDeviceStatus = null
let offDeviceMessage = null

/* ---------------- 与网页面试房间的连接 ---------------- */
const connection = ref({
  status: 'idle',
  message: '',
  platformLabel: '',
  interviewId: null
})

const connected = computed(() => connection.value.status === 'connected')

const connectionText = computed(() => {
  const current = connection.value
  if (current.status === 'connected') {
    return `已连接 ${current.platformLabel || '网页端'}`
  }
  if (current.status === 'connecting') return current.message || '正在连接…'
  if (current.status === 'offline') return current.message || '连接已断开，正在重连…'
  if (current.status === 'error') return current.message || '连接失败'
  if (current.status === 'idle') return current.message || '未连接网页端'
  return '未连接网页端'
})

/* ---------------- 连接新设备弹窗 ---------------- */
const showPairDialog = ref(false)
const pairing = ref(false)
const pairError = ref('')
const pairCode = ref(['', '', '', '', '', ''])
const pairInputs = ref([])

function setPairInput(index, el) {
  if (el) pairInputs.value[index] = el
}

function openPairDialog() {
  if (showPairDialog.value) return
  pairCode.value = ['', '', '', '', '', '']
  pairError.value = ''
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
  pairError.value = ''
  pairing.value = true
  try {
    const result = await window.api.pairDevice(code)
    if (!result.ok) {
      pairing.value = false
      pairError.value = result.message || '连接失败'
      showToast(pairError.value)
    }
    // 成功时保持「连接中」，等 device:status 推送 device.ready 后再关闭弹窗
  } catch (error) {
    pairing.value = false
    pairError.value = '连接失败：' + error.message
    showToast(pairError.value)
  }
}

function handleDeviceStatus(payload) {
  if (!payload) return
  connection.value = payload

  // 与网页端的实时通道不可用时停止上传，重连后网页会重新下发开始指令
  if (payload.status !== 'connected') {
    stopInterviewCapture()
  }

  if (payload.status === 'connected') {
    pairing.value = false
    pairError.value = ''
    showPairDialog.value = false
    showToast('设备连接成功')
  } else if (payload.status === 'error') {
    pairing.value = false
    pairError.value = payload.message || '连接失败'
    showToast(pairError.value)
  } else if (payload.status === 'offline') {
    showToast(payload.message || '连接已断开，正在重连…')
  } else if (payload.status === 'idle') {
    pairing.value = false
    // 网页端退出房间时带原因（message），主动断开连接时为空，不重复提示
    if (payload.message) showToast(payload.message)
  }
}

async function disconnectDevice() {
  await window.api.disconnectDevice()
  showToast('已断开连接')
}

/** 网页端点击「播放测试音频」时，在电脑上播放一段提示音 */
function playTestTone() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 660
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.05)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.2)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 1.3)
    osc.addEventListener('ended', () => ctx.close())
    showToast('正在播放测试音频')
  } catch (error) {
    showToast('播放测试音频失败')
    console.error(error)
  }
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

/* ---------------- 面试音频实时上传（语音转文字） ---------------- */

function sendAudioFrame(frame) {
  window.api.sendDeviceAudio(frame)
}

function startMicCapture() {
  if (micCapture || !micStream) return
  const capture = createPcmCapture({
    speaker: 1,
    getStream: () => micStream,
    send: sendAudioFrame
  })
  micCapture = capture
  capture.start().catch((error) => {
    if (micCapture === capture) micCapture = null
    showToast('麦克风音频上传失败：' + error.message)
    console.error(error)
  })
}

function stopMicCapture() {
  micCapture?.stop()
  micCapture = null
}

function startSystemCapture() {
  if (systemCapture || !systemStream) return
  const capture = createPcmCapture({
    speaker: 0,
    getStream: () => systemStream,
    send: sendAudioFrame
  })
  systemCapture = capture
  capture.start().catch((error) => {
    if (systemCapture === capture) systemCapture = null
    showToast('系统音频上传失败：' + error.message)
    console.error(error)
  })
}

function stopSystemCapture() {
  systemCapture?.stop()
  systemCapture = null
}

/** 网页端点击「开始面试」后才采集，避免未开始时占用麦克风与带宽 */
function startInterviewCapture() {
  interviewActive = true
  startMicCapture()
  startSystemCapture()
}

function stopInterviewCapture() {
  interviewActive = false
  stopMicCapture()
  stopSystemCapture()
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
  // 面试进行中切换了麦克风：沿用采集，让识别不断档
  if (interviewActive) startMicCapture()
}

function stopMic() {
  stopMicCapture()
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
      audio: {
        deviceId: { exact: micId.value },
        // 与默认麦克风保持一致：抑制外放声音被麦克风再次采集，避免「我」这一侧重复识别面试官的声音
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    await applyMicStream(stream)
  } catch (error) {
    showToast('切换麦克风失败：' + error.message)
  }
}

function stopSystem() {
  stopSystemCapture()
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
    if (interviewActive) startSystemCapture()
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

onMounted(async () => {
  refreshMic()
  // 启动即开始采集系统音频，音量条才能在面试开始前就跟随声音跳动
  loadDisplaySources()
    .then(() => onSystemChange())
    .catch((error) => console.error(error))
  try {
    connection.value = await window.api.getDeviceStatus()
  } catch (error) {
    console.error(error)
  }
  offDeviceStatus = window.api.onDeviceStatus(handleDeviceStatus)
  offDeviceMessage = window.api.onDeviceMessage((payload) => {
    if (!payload) return
    if (payload.type === 'audio.test') {
      playTestTone()
    } else if (payload.type === 'interview.start') {
      startInterviewCapture()
    } else if (payload.type === 'interview.stop') {
      stopInterviewCapture()
    }
  })
  // 把两路音量上报给网页端，用于音频自检（真正的音频流后续接入）
  levelTimer = setInterval(() => {
    if (!connected.value) return
    window.api.sendDeviceMessage({
      type: 'audio.level',
      data: {
        mic: Number(micLevel.value.toFixed(3)),
        system: Number(systemLevel.value.toFixed(3))
      }
    })
  }, 200)
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
  clearInterval(levelTimer)
  stopInterviewCapture()
  stopMic()
  stopSystem()
  offClipboard?.()
  offScreenshot?.()
  offDeviceStatus?.()
  offDeviceMessage?.()
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
          <div class="row-sub">{{ connectionText }}</div>
        </div>
        <div class="row-controls">
          <template v-if="connected">
            <button class="danger-btn" @click="disconnectDevice">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6 6 18"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
              断开连接
            </button>
          </template>
          <template v-else>
            <button class="ghost-btn" @click="showToast('使用教程正在制作中')">使用教程</button>
            <button class="dark-btn" @click="openPairDialog">
              <span class="plus">+</span>连接设备
            </button>
          </template>
        </div>
      </div>
    </div>

    <div v-else class="settings-list">
      <!-- todu 文本复制监听 -->
      <!-- <div class="panel setting-card">
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
      </div> -->

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
          <div class="row-sub">截取当前屏幕并发送给配对设备（修改功能暂未开放）</div>
        </div>
        <div class="shortcut-controls">
          <div class="shortcut-box" title="当前快捷键，暂不支持修改">
            <template v-for="(key, index) in shortcutKeys" :key="key + index">
              <span v-if="index > 0" class="key-plus">+</span>
              <kbd>{{ key }}</kbd>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div class="footer">
      <span class="copyright">EasyOffer v1.0.0</span>
      <div class="footer-links">
        <button @click="showToast('使用教程正在制作中')">使用教程</button>
        <button @click="showToast('官网正在制作中')">打开官网</button>
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

            <p v-if="pairError" class="pair-error">{{ pairError }}</p>

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
  background: #f3f4f6;
  border: 1px solid #e6e8ec;
  border-radius: 8px;
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

.danger-btn {
  display: flex;
  gap: 6px;
  align-items: center;
  height: 38px;
  padding: 0 18px;
  font-size: 14px;
  color: #fff;
  background: #e5484d;
  border: none;
  border-radius: 8px;
  transition: background 0.15s ease;
}

.danger-btn:hover {
  background: #cf3a3f;
}

.danger-btn svg {
  width: 14px;
  height: 14px;
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

.pair-error {
  margin: -10px 0 14px;
  font-size: 12.5px;
  color: #e5484d;
  text-align: center;
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
