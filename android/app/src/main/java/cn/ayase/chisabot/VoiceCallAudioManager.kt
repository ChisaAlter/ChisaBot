package cn.ayase.chisabot

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build

/**
 * Android 端实时语音通话原生音频增强与焦点管理器：
 * - 切入 `AudioManager.MODE_IN_COMMUNICATION` 并申请语音通信音频焦点；
 * - 在支持的硬件上自动挂载 `AcousticEchoCanceler`（硬件回声消除）与 `NoiseSuppressor`（硬件降噪）；
 * - 通话结束或异常退出时幂等释放音频特效、音频焦点并恢复原有音频模式。
 */
class VoiceCallAudioManager(context: Context) {

    data class EffectAttachment(
        val echoCancelerEnabled: Boolean,
        val noiseSuppressorEnabled: Boolean,
    )

    private val audioManager: AudioManager =
        context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var active: Boolean = false
    private var previousMode: Int = AudioManager.MODE_NORMAL
    private var previousSpeakerphoneOn: Boolean = false
    private var focusRequest: AudioFocusRequest? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null

    private val focusChangeListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_LOSS) {
            release()
        }
    }

    /** 当前设备是否支持硬件级回声消除（AEC）。 */
    fun isHardwareAecAvailable(): Boolean = AcousticEchoCanceler.isAvailable()

    /** 当前设备是否支持硬件级噪声抑制（NS）。 */
    fun isNoiseSuppressorAvailable(): Boolean = NoiseSuppressor.isAvailable()

    /**
     * 协商给服务端的音频处理能力标识：
     * 支持硬件 AEC 时上报 `native-aec3-v1`，否则降级为 `web-aec-v1`。
     */
    fun negotiatedAudioProcessing(): String =
        if (isHardwareAecAvailable()) "native-aec3-v1" else "web-aec-v1"

    /**
     * 开启语音通话音频会话：申请通信焦点并切入 `MODE_IN_COMMUNICATION`。
     * 返回 true 表示成功获得音频焦点。
     */
    @Synchronized
    fun acquireCommunicationAudio(speakerphoneOn: Boolean = true): Boolean {
        if (active) {
            setSpeakerphone(speakerphoneOn)
            return true
        }

        previousMode = audioManager.mode
        @Suppress("DEPRECATION")
        previousSpeakerphoneOn = audioManager.isSpeakerphoneOn

        val granted = requestVoiceFocus()
        if (!granted) {
            return false
        }

        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        setSpeakerphone(speakerphoneOn)
        active = true
        return true
    }

    /** 为指定 `AudioRecord` / WebRTC 采集会话挂载硬件 AEC 与 NS 特效。 */
    @Synchronized
    fun attachCaptureEffects(audioSessionId: Int): EffectAttachment {
        detachEffects()
        if (audioSessionId <= 0) {
            return EffectAttachment(
                echoCancelerEnabled = false,
                noiseSuppressorEnabled = false,
            )
        }

        var aecEnabled = false
        if (AcousticEchoCanceler.isAvailable()) {
            try {
                val aec = AcousticEchoCanceler.create(audioSessionId)
                if (aec != null) {
                    aec.enabled = true
                    echoCanceler = aec
                    aecEnabled = aec.enabled
                }
            } catch (_: Throwable) {
                echoCanceler?.release()
                echoCanceler = null
            }
        }

        var nsEnabled = false
        if (NoiseSuppressor.isAvailable()) {
            try {
                val ns = NoiseSuppressor.create(audioSessionId)
                if (ns != null) {
                    ns.enabled = true
                    noiseSuppressor = ns
                    nsEnabled = ns.enabled
                }
            } catch (_: Throwable) {
                noiseSuppressor?.release()
                noiseSuppressor = null
            }
        }

        return EffectAttachment(
            echoCancelerEnabled = aecEnabled,
            noiseSuppressorEnabled = nsEnabled,
        )
    }

    /** 切换免提扬声器路由（未连接耳机/蓝牙时生效）。 */
    @Synchronized
    fun setSpeakerphone(enabled: Boolean) {
        @Suppress("DEPRECATION")
        audioManager.isSpeakerphoneOn = enabled
    }

    /** 释放所有硬件音频特效、归还音频焦点并恢复通话前的系统音频模式。 */
    @Synchronized
    fun release() {
        detachEffects()
        if (!active) {
            abandonVoiceFocus()
            return
        }
        active = false
        try {
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = previousSpeakerphoneOn
            audioManager.mode = previousMode
        } catch (_: Throwable) {
            // 忽略音频服务销毁阶段的状态恢复异常
        }
        abandonVoiceFocus()
    }

    private fun detachEffects() {
        try {
            echoCanceler?.enabled = false
            echoCanceler?.release()
        } catch (_: Throwable) {
            // 忽略释放异常
        } finally {
            echoCanceler = null
        }

        try {
            noiseSuppressor?.enabled = false
            noiseSuppressor?.release()
        } catch (_: Throwable) {
            // 忽略释放异常
        } finally {
            noiseSuppressor = null
        }
    }

    private fun requestVoiceFocus(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attrs)
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener(focusChangeListener)
                .build()
            focusRequest = request
            audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            val result = audioManager.requestAudioFocus(
                focusChangeListener,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
            )
            result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
    }

    private fun abandonVoiceFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { req ->
                try {
                    audioManager.abandonAudioFocusRequest(req)
                } catch (_: Throwable) {
                    // 忽略焦点归还异常
                }
            }
            focusRequest = null
        } else {
            @Suppress("DEPRECATION")
            try {
                audioManager.abandonAudioFocus(focusChangeListener)
            } catch (_: Throwable) {
                // 忽略焦点归还异常
            }
        }
    }
}
