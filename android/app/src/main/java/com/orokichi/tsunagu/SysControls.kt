package com.orokichi.tsunagu

import android.app.NotificationManager
import android.content.Context
import android.media.AudioManager
import android.provider.Settings
import org.json.JSONObject

/**
 * Phone quick settings the PC can read and toggle (ホームの「スマホのクイック設定」と音量).
 *
 *  - 自動回転: Settings.System.ACCELEROMETER_ROTATION — needs the user to grant
 *    「システム設定の変更」(WRITE_SETTINGS, Settings.ACTION_MANAGE_WRITE_SETTINGS).
 *  - 着信モード / サイレント (Do Not Disturb): AudioManager ringer mode and
 *    NotificationManager.setInterruptionFilter — entering or leaving silent and
 *    changing DND need 「サイレントモードへのアクセス」(ACCESS_NOTIFICATION_POLICY).
 *  - メディアの音量: STREAM_MUSIC via AudioManager (no grant needed).
 *
 * Every setter returns null on success or a Japanese error message for the PC.
 */
object SysControls {
    fun canWrite(c: Context): Boolean = Settings.System.canWrite(c)
    fun dndAccess(c: Context): Boolean = c.getSystemService(NotificationManager::class.java).isNotificationPolicyAccessGranted

    private fun am(c: Context) = c.getSystemService(AudioManager::class.java)
    private fun nm(c: Context) = c.getSystemService(NotificationManager::class.java)

    fun state(c: Context): JSONObject {
        val am = am(c)
        val rotate = runCatching { Settings.System.getInt(c.contentResolver, Settings.System.ACCELEROMETER_ROTATION) == 1 }.getOrNull()
        val ringer = when (am.ringerMode) {
            AudioManager.RINGER_MODE_SILENT -> "silent"
            AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
            else -> "normal"
        }
        val filter = nm(c).currentInterruptionFilter
        val dnd = filter != NotificationManager.INTERRUPTION_FILTER_ALL && filter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN
        return JSONObject()
            .put("rotate", rotate ?: JSONObject.NULL)
            .put("canWrite", canWrite(c))
            .put("ringer", ringer)
            .put("dnd", dnd)
            .put("dndAccess", dndAccess(c))
            .put("vol", am.getStreamVolume(AudioManager.STREAM_MUSIC))
            .put("volMax", am.getStreamMaxVolume(AudioManager.STREAM_MUSIC))
            .put("volMin", am.getStreamMinVolume(AudioManager.STREAM_MUSIC))
            .put("muted", am.isStreamMute(AudioManager.STREAM_MUSIC))
    }

    fun setRotate(c: Context, on: Boolean): String? {
        if (!canWrite(c)) return "スマホで「システム設定の変更」を許可してください"
        return runCatching {
            Settings.System.putInt(c.contentResolver, Settings.System.ACCELEROMETER_ROTATION, if (on) 1 else 0)
            null
        }.getOrElse { "自動回転を切り替えられませんでした" }
    }

    fun setRinger(c: Context, mode: String): String? {
        val am = am(c)
        val target = when (mode) {
            "silent" -> AudioManager.RINGER_MODE_SILENT
            "vibrate" -> AudioManager.RINGER_MODE_VIBRATE
            else -> AudioManager.RINGER_MODE_NORMAL
        }
        // Entering or leaving silent toggles Do Not Disturb on recent Android,
        // which the platform only allows with notification-policy access.
        if (!dndAccess(c) && (target == AudioManager.RINGER_MODE_SILENT || am.ringerMode == AudioManager.RINGER_MODE_SILENT)) {
            return "スマホで「サイレントモードへのアクセス」を許可してください"
        }
        return runCatching { am.ringerMode = target; null }.getOrElse { "着信モードを変更できませんでした" }
    }

    fun setDnd(c: Context, on: Boolean): String? {
        if (!dndAccess(c)) return "スマホで「サイレントモードへのアクセス」を許可してください"
        return runCatching {
            nm(c).setInterruptionFilter(if (on) NotificationManager.INTERRUPTION_FILTER_PRIORITY else NotificationManager.INTERRUPTION_FILTER_ALL)
            null
        }.getOrElse { "サイレントモードを切り替えられませんでした" }
    }

    fun setVolume(c: Context, value: Int): String? {
        val am = am(c)
        val v = value.coerceIn(am.getStreamMinVolume(AudioManager.STREAM_MUSIC), am.getStreamMaxVolume(AudioManager.STREAM_MUSIC))
        return runCatching {
            if (am.isStreamMute(AudioManager.STREAM_MUSIC) && v > 0) am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0)
            am.setStreamVolume(AudioManager.STREAM_MUSIC, v, 0)
            null
        }.getOrElse { "音量を変更できませんでした" }
    }

    fun stepVolume(c: Context, dir: Int): String? = runCatching {
        am(c).adjustStreamVolume(AudioManager.STREAM_MUSIC, if (dir > 0) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER, 0)
        null
    }.getOrElse { "音量を変更できませんでした" }

    fun setMute(c: Context, on: Boolean): String? = runCatching {
        am(c).adjustStreamVolume(AudioManager.STREAM_MUSIC, if (on) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE, 0)
        null
    }.getOrElse { "ミュートを切り替えられませんでした" }
}
