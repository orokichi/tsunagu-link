package com.orokichi.tsunagu

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Settings
import android.provider.Telephony
import android.telecom.TelecomManager
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import android.util.Size
import org.json.JSONArray
import org.json.JSONObject

class Features(private val ctx: Context) {
    private val cr = ctx.contentResolver
    private fun has(p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    // ---------- device ----------
    fun hello(token: String): JSONObject {
        val name = Settings.Global.getString(cr, Settings.Global.DEVICE_NAME) ?: Build.MODEL
        val seed = runCatching { String.format("#%06X", 0xFFFFFF and ctx.getColor(android.R.color.system_accent1_500)) }.getOrNull()
        return JSONObject().put("name", name).put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("android", Build.VERSION.RELEASE).put("token", token).put("seed", seed ?: JSONObject.NULL)
    }

    @SuppressLint("MissingPermission")
    fun info(): JSONObject {
        val b = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = b?.let { it.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) * 100 / it.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1) } ?: 0
        val plugged = (b?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val net = when {
            caps == null -> "オフライン"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "モバイル通信"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "有線"
            else -> "接続中"
        }
        val tm = ctx.getSystemService(TelephonyManager::class.java)
        val st = StatFs(Environment.getDataDirectory().path)
        val am = ctx.getSystemService(AudioManager::class.java)
        val ringer = when (am.ringerMode) { AudioManager.RINGER_MODE_SILENT -> "サイレント"; AudioManager.RINGER_MODE_VIBRATE -> "バイブ"; else -> "着信音" }
        return JSONObject().put("battery", level).put("charging", plugged).put("net", net)
            .put("carrier", tm?.networkOperatorName?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
            .put("storageFree", st.availableBytes).put("storageTotal", st.totalBytes).put("ringer", ringer)
    }

    // ---------- notifications ----------
    fun notifications(): JSONArray {
        val arr = JSONArray()
        NotifListener.instance?.items()?.forEach { arr.put(it) }
        return arr
    }

    // ---------- media ----------
    private val main = Handler(Looper.getMainLooper())
    private var controllers: List<MediaController> = emptyList()
    private val cb = object : MediaController.Callback() {
        override fun onPlaybackStateChanged(state: PlaybackState?) = push()
        override fun onMetadataChanged(metadata: MediaMetadata?) = push()
        override fun onSessionDestroyed() = push()
    }
    private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { list -> rebind(list ?: emptyList()) }
    private var pushPending = false
    private fun push() {
        if (pushPending) return
        pushPending = true
        main.postDelayed({ pushPending = false; LinkService.instance?.onMedia(mediaState()) }, 400)
    }
    private fun rebind(list: List<MediaController>) {
        controllers.forEach { runCatching { it.unregisterCallback(cb) } }
        controllers = list
        list.forEach { it.registerCallback(cb, main) }
        push()
    }
    private fun msm() = ctx.getSystemService(MediaSessionManager::class.java)
    private val listenerCn get() = ComponentName(ctx, NotifListener::class.java)
    fun watchMedia() {
        runCatching {
            msm().addOnActiveSessionsChangedListener(sessionsListener, listenerCn, main)
            rebind(msm().getActiveSessions(listenerCn))
        }
    }
    fun unwatchMedia() { runCatching { msm().removeOnActiveSessionsChangedListener(sessionsListener) }; controllers.forEach { runCatching { it.unregisterCallback(cb) } } }
    private fun active(): MediaController? {
        val list = runCatching { msm().getActiveSessions(listenerCn) }.getOrNull() ?: controllers
        return list.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: list.firstOrNull()
    }
    fun mediaState(): JSONObject? {
        val c = active() ?: return null
        val md = c.metadata ?: return null
        val title = md.getString(MediaMetadata.METADATA_KEY_TITLE) ?: return null
        val ps = c.playbackState
        val app = runCatching { ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(c.packageName, 0)).toString() }.getOrDefault(c.packageName)
        val art = (md.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) ?: md.getBitmap(MediaMetadata.METADATA_KEY_ART))?.let { Img.toB64(Img.scale(it, 240)) }
        return JSONObject().put("app", app).put("title", title)
            .put("artist", md.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: md.getString(MediaMetadata.METADATA_KEY_ALBUM) ?: "")
            .put("playing", ps?.state == PlaybackState.STATE_PLAYING)
            .put("position", ps?.position ?: 0).put("duration", md.getLong(MediaMetadata.METADATA_KEY_DURATION))
            .put("art", art ?: JSONObject.NULL)
    }
    fun mediaCommand(cmd: String) {
        val t = active()?.transportControls ?: return
        main.post { when (cmd) { "play" -> t.play(); "pause" -> t.pause(); "next" -> t.skipToNext(); "prev" -> t.skipToPrevious() } }
    }

    // ---------- contacts ----------
    private val names = HashMap<String, String?>()
    fun contactName(number: String): String? {
        if (number.isBlank() || !has(Manifest.permission.READ_CONTACTS)) return null
        return names.getOrPut(number) {
            runCatching {
                cr.query(Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number)),
                    arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
            }.getOrNull()
        }
    }

    // ---------- SMS ----------
    fun threads(): JSONArray {
        val arr = JSONArray()
        if (!has(Manifest.permission.READ_SMS)) return arr
        val seen = HashSet<Long>()
        runCatching {
            cr.query(Telephony.Sms.CONTENT_URI, arrayOf(Telephony.Sms.THREAD_ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.READ),
                null, null, "${Telephony.Sms.DATE} DESC")?.use { c ->
                var scanned = 0
                while (c.moveToNext() && scanned++ < 3000 && arr.length() < 60) {
                    val tid = c.getLong(0)
                    if (!seen.add(tid)) continue
                    val addr = c.getString(1) ?: ""
                    arr.put(JSONObject().put("id", tid.toString()).put("address", addr).put("name", contactName(addr) ?: JSONObject.NULL)
                        .put("snippet", c.getString(2) ?: "").put("time", c.getLong(3)).put("unread", c.getInt(4) == 0))
                }
            }
        }
        return arr
    }
    fun sms(threadId: String): JSONArray {
        val list = ArrayList<JSONObject>()
        if (!has(Manifest.permission.READ_SMS)) return JSONArray()
        runCatching {
            cr.query(Telephony.Sms.CONTENT_URI, arrayOf(Telephony.Sms._ID, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE),
                "${Telephony.Sms.THREAD_ID}=?", arrayOf(threadId), "${Telephony.Sms.DATE} DESC")?.use { c ->
                while (c.moveToNext() && list.size < 150) {
                    list.add(JSONObject().put("id", c.getString(0)).put("body", c.getString(1) ?: "").put("time", c.getLong(2))
                        .put("mine", c.getInt(3) != Telephony.Sms.MESSAGE_TYPE_INBOX))
                }
            }
        }
        return JSONArray(list.reversed())
    }
    fun threadIdFor(address: String): String? = runCatching { Telephony.Threads.getOrCreateThreadId(ctx, address).toString() }.getOrNull()
    fun sendSms(to: String, body: String): Boolean {
        if (!has(Manifest.permission.SEND_SMS) || to.isBlank() || body.isBlank()) return false
        return runCatching {
            val sm = ctx.getSystemService(SmsManager::class.java)
            sm.sendMultipartTextMessage(to, null, sm.divideMessage(body), null, null)
            true
        }.getOrDefault(false)
    }

    // ---------- calls ----------
    fun calls(): JSONArray {
        val arr = JSONArray()
        if (!has(Manifest.permission.READ_CALL_LOG)) return arr
        runCatching {
            cr.query(CallLog.Calls.CONTENT_URI, arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION),
                null, null, "${CallLog.Calls.DATE} DESC")?.use { c ->
                while (c.moveToNext() && arr.length() < 100) {
                    arr.put(JSONObject().put("number", c.getString(0) ?: "").put("name", c.getString(1) ?: JSONObject.NULL)
                        .put("type", c.getInt(2)).put("time", c.getLong(3)).put("duration", c.getLong(4)))
                }
            }
        }
        return arr
    }
    @SuppressLint("MissingPermission")
    fun dial(number: String): Boolean {
        if (!has(Manifest.permission.CALL_PHONE) || number.isBlank()) return false
        return runCatching { ctx.getSystemService(TelecomManager::class.java).placeCall(Uri.fromParts("tel", number, null), Bundle()); true }.getOrDefault(false)
    }
    @SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    fun endCall() { if (has(Manifest.permission.ANSWER_PHONE_CALLS)) runCatching { ctx.getSystemService(TelecomManager::class.java).endCall() } }

    // ---------- photos & videos ----------
    fun photos(offset: Int, limit: Int): Pair<JSONArray, Boolean> {
        val arr = JSONArray()
        val canImg = has(Manifest.permission.READ_MEDIA_IMAGES); val canVid = has(Manifest.permission.READ_MEDIA_VIDEO)
        if (!canImg && !canVid) return arr to false
        val types = listOfNotNull(if (canImg) MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE else null, if (canVid) MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO else null)
        val args = Bundle().apply {
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (${types.joinToString(",")})")
            putStringArray(android.content.ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf(MediaStore.Files.FileColumns.DATE_ADDED))
            putInt(android.content.ContentResolver.QUERY_ARG_SORT_DIRECTION, android.content.ContentResolver.QUERY_SORT_DIRECTION_DESCENDING)
            putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, limit + 1)
            putInt(android.content.ContentResolver.QUERY_ARG_OFFSET, offset)
        }
        var more = false
        runCatching {
            cr.query(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL),
                arrayOf(MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.Files.FileColumns.DATE_ADDED,
                    MediaStore.Files.FileColumns.DISPLAY_NAME, MediaStore.Files.FileColumns.SIZE, MediaStore.Video.VideoColumns.DURATION), args, null)?.use { c ->
                while (c.moveToNext()) {
                    if (arr.length() >= limit) { more = true; break }
                    val id = c.getLong(0); val video = c.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
                    val uri = itemUri(id, video)
                    val thumb = runCatching { Img.toB64(cr.loadThumbnail(uri, Size(320, 320), null), q = 72) }.getOrNull() ?: continue
                    arr.put(JSONObject().put("id", (if (video) "v" else "i") + id).put("video", video).put("time", c.getLong(2) * 1000)
                        .put("name", c.getString(3) ?: "").put("size", c.getLong(4)).put("duration", if (video) c.getLong(5) else 0).put("thumb", thumb))
                }
            }
        }
        return arr to more
    }
    private fun itemUri(id: Long, video: Boolean) = ContentUris.withAppendedId(if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
    fun photoUri(key: String): Uri? = key.drop(1).toLongOrNull()?.let { itemUri(it, key.startsWith("v")) }

    // ---------- links ----------
    fun openUrl(url: String) {
        if (!url.startsWith("http")) return
        val i = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Settings.canDrawOverlays(ctx)) { if (runCatching { ctx.startActivity(i) }.isSuccess) return }
        val pi = PendingIntent.getActivity(ctx, url.hashCode(), i, PendingIntent.FLAG_IMMUTABLE)
        ctx.getSystemService(NotificationManager::class.java).notify(url.hashCode(), Notification.Builder(ctx, App.CH_EVENT)
            .setSmallIcon(R.drawable.ic_stat).setContentTitle("PC からのリンク").setContentText(url)
            .setContentIntent(pi).setAutoCancel(true).build())
    }
}

/** Rings the phone at alarm volume (works even in silent mode). */
class Ringer(private val ctx: Context) {
    private var mp: MediaPlayer? = null
    private val am = ctx.getSystemService(AudioManager::class.java)
    private var oldVol = -1
    private val h = Handler(Looper.getMainLooper())
    fun start() {
        val uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        oldVol = am.getStreamVolume(AudioManager.STREAM_ALARM)
        runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0) }
        mp = runCatching {
            MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                setDataSource(ctx, uri); isLooping = true; prepare(); start()
            }
        }.getOrNull()
        val stop = PendingIntent.getBroadcast(ctx, 7, Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.STOP_RING), PendingIntent.FLAG_IMMUTABLE)
        ctx.getSystemService(NotificationManager::class.java).notify(7, Notification.Builder(ctx, App.CH_EVENT)
            .setSmallIcon(R.drawable.ic_stat).setContentTitle("PC からスマホを鳴らしています").setContentText("タップして停止")
            .setContentIntent(stop).addAction(Notification.Action.Builder(null, "停止", stop).build()).setOngoing(true).build())
        current = this
        h.postDelayed({ stop() }, 45_000)
    }
    fun stop() {
        h.removeCallbacksAndMessages(null)
        mp?.runCatching { stop(); release() }; mp = null
        if (oldVol >= 0) runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, oldVol, 0) }
        ctx.getSystemService(NotificationManager::class.java).cancel(7)
        if (current === this) current = null
    }
    companion object { var current: Ringer? = null }
}
