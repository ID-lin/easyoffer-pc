/**
 * 面试音频采集：把麦克风 / 系统音频转成 16 kHz 单声道 PCM16 分片。
 *
 * 每帧格式（发给主进程 -> /ws/device）：
 *   [0] 音源：0=系统音频（面试官），1=麦克风（我）
 *   [1..] 小端 PCM16
 *
 * 服务端按音源分别送实时识别，识别结果推送到网页端左右两侧展示。
 *
 * 帧级静音抑制：静音帧不上传，只保留一小段句首预缓冲和句尾静音，
 * 减少长期面试时的上传带宽、本机 IPC 开销与云端识别计费时长。
 */

const SAMPLE_RATE = 16000
/** 200 ms 一帧，兼顾延迟与本机 IPC / WebSocket 开销 */
const CHUNK_SAMPLES = SAMPLE_RATE / 5
/** 帧 RMS 低于该值视为静音（约 -50 dBFS）；选得偏低，宁可多传也不吞字 */
const RMS_THRESHOLD = 0.003
/** 检测到语音时补发之前缓存的帧数（200ms/帧），避免吞掉句首 */
const PREROLL_FRAMES = 3
/** 语音结束后继续上传的静音帧数，覆盖服务端 maxSentenceSilence=800ms，保证正常断句 */
const HANGOVER_FRAMES = 6
/**
 * 静音时每 15 秒补发一帧静音（75 帧 × 200ms）。
 * 百炼在约 23 秒收不到音频时会关闭识别任务，补一帧可避免下一句话被迫重连；
 * 只在已经说过话之后发送，整场没出声的那一路不会白建云端连接。
 */
const KEEPALIVE_SILENT_FRAMES = 75

/** AudioWorklet 只能通过 URL 加载；内联成 Blob，打包后不受 file:// 限制 */
const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const config = options.processorOptions || {}
    this.size = config.chunkSize || 3200
    this.buffer = new Float32Array(this.size)
    this.offset = 0
    this.threshold = config.rmsThreshold || 0.003
    this.prerollSize = config.prerollFrames || 3
    this.hangoverFrames = config.hangoverFrames || 6
    this.keepaliveFrames = config.keepaliveFrames || 75
    // 句首预缓冲：静音时滚动保留最近几帧，检测到语音后连同当前帧一起发出
    this.preroll = []
    // 仍在说话（或句尾静音尚未发完）时，剩余要发送的静音帧数
    this.hold = 0
    this.speaking = false
    // 连续未发送的静音帧数，用于低频保活
    this.silentFrames = 0
    this.everSpoken = false
  }

  postFrame(frame) {
    this.port.postMessage(frame)
    this.silentFrames = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let read = 0
    while (read < channel.length) {
      const count = Math.min(channel.length - read, this.size - this.offset)
      this.buffer.set(channel.subarray(read, read + count), this.offset)
      this.offset += count
      read += count
      if (this.offset === this.size) {
        this.emitFrame(this.buffer.slice(0))
        this.offset = 0
      }
    }
    return true
  }

  emitFrame(frame) {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / frame.length)

    if (rms >= this.threshold) {
      this.hold = this.hangoverFrames
      this.everSpoken = true
      if (!this.speaking) {
        this.speaking = true
        // 先补发检测到语音之前的音频，保证句首完整
        for (let i = 0; i < this.preroll.length; i++) {
          this.postFrame(this.preroll[i])
        }
        this.preroll.length = 0
      }
      this.postFrame(frame)
      return
    }

    if (this.speaking) {
      // 句尾静音：让识别服务按 maxSentenceSilence 正常断句
      this.postFrame(frame)
      this.hold -= 1
      if (this.hold <= 0) this.speaking = false
      return
    }

    this.preroll.push(frame)
    if (this.preroll.length > this.prerollSize) this.preroll.shift()

    this.silentFrames += 1
    if (this.everSpoken && this.silentFrames >= this.keepaliveFrames) {
      // 长时间静音补一帧，保持云端识别任务不断开
      this.postFrame(frame)
    }
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor)
`

let workletUrl = null

function getWorkletUrl() {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
  }
  return workletUrl
}

function toPcmFrame(samples, speaker) {
  const frame = new Uint8Array(1 + samples.length * 2)
  frame[0] = speaker
  const view = new DataView(frame.buffer, 1)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
  }
  return frame
}

/**
 * @param {object} options
 * @param {number} options.speaker 0=系统音频（面试官），1=麦克风（我）
 * @param {() => MediaStream | null} options.getStream 读取当前音频流
 * @param {(frame: Uint8Array) => void} options.send 发送一帧；链路断开时丢弃即可
 */
export function createPcmCapture({ speaker, getStream, send }) {
  let context = null
  let source = null
  let node = null
  let gain = null
  let running = false
  let generation = 0

  async function start() {
    if (running) return
    const stream = getStream()
    if (!stream) return

    running = true
    const token = ++generation

    try {
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
      context = ctx
      await ctx.audioWorklet.addModule(getWorkletUrl())
      if (token !== generation) {
        teardown()
        return
      }

      source = ctx.createMediaStreamSource(stream)
      node = new AudioWorkletNode(ctx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: {
          chunkSize: CHUNK_SAMPLES,
          rmsThreshold: RMS_THRESHOLD,
          prerollFrames: PREROLL_FRAMES,
          hangoverFrames: HANGOVER_FRAMES,
          keepaliveFrames: KEEPALIVE_SILENT_FRAMES
        }
      })
      // 只为了让节点持续渲染，不把采集到的声音再播放出来
      gain = ctx.createGain()
      gain.gain.value = 0

      node.port.onmessage = (event) => {
        if (running) send(toPcmFrame(event.data, speaker))
      }
      source.connect(node)
      node.connect(gain)
      gain.connect(ctx.destination)
      await ctx.resume()

      if (token !== generation) {
        teardown()
      }
    } catch (error) {
      if (token !== generation) return
      running = false
      teardown()
      throw error
    }
  }

  function teardown() {
    if (node) {
      node.port.onmessage = null
      node.port.close()
      node.disconnect()
    }
    if (gain) gain.disconnect()
    if (source) source.disconnect()
    if (context) {
      context.close().catch(() => {})
    }
    context = null
    source = null
    node = null
    gain = null
  }

  function stop() {
    running = false
    generation += 1
    teardown()
  }

  return { start, stop }
}
