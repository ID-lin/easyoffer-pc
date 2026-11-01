/**
 * 面试音频采集：把麦克风 / 系统音频转成 16 kHz 单声道 PCM16 分片。
 *
 * 每帧格式（发给主进程 -> /ws/device）：
 *   [0] 音源：0=系统音频（面试官），1=麦克风（我）
 *   [1..] 小端 PCM16
 *
 * 服务端按音源分别送实时识别，识别结果推送到网页端左右两侧展示。
 */

const SAMPLE_RATE = 16000
/** 200 ms 一帧，兼顾延迟与本机 IPC / WebSocket 开销 */
const CHUNK_SAMPLES = SAMPLE_RATE / 5

/** AudioWorklet 只能通过 URL 加载；内联成 Blob，打包后不受 file:// 限制 */
const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.size = options.processorOptions?.chunkSize || 3200
    this.buffer = new Float32Array(this.size)
    this.offset = 0
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
        this.port.postMessage(this.buffer.slice(0))
        this.offset = 0
      }
    }
    return true
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
        processorOptions: { chunkSize: CHUNK_SAMPLES }
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
