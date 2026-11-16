package com.orokichi.tsunagu

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
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
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume

class Features(private val ctx: Context) {
    private val cr = ctx.contentResolver
    private fun has(p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    // ---------- device ----------
    /** This phone's site-local IPv4 addresses (Wi-Fi first) + the LAN signaling
     *  port, so a paired PC on the same network can reach us directly. */
    fun lanJson(): JSONObject {
        val ips = JSONArray()
        runCatching {
            val ifs = java.net.NetworkInterface.getNetworkInterfaces().toList()
                .filter { runCatching { it.isUp && !it.isLoopback }.getOrDefault(false) }
                .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
            val seen = HashSet<String>()
            for (ni in ifs) {
                for (addr in ni.inetAddresses) {
                    val h = addr.hostAddress ?: continue
                    if (addr is java.net.Inet4Address && addr.isSiteLocalAddress && seen.add(h)) ips.put(h)
                    if (ips.length() >= 4) break
                }
                if (ips.length() >= 4) break
            }
        }
        return JSONObject().put("ips", ips).put("port", LinkService.lanPort)
    }

    fun hello(token: String): JSONObject {
        val name = Settings.Global.getString(cr, Settings.Global.DEVICE_NAME) ?: Build.MODEL
        val seed = runCatching { String.format("#%06X", 0xFFFFFF and ctx.getColor(android.R.color.system_accent1_500)) }.getOrNull()
        return JSONObject().put("name", name).put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("android", Build.VERSION.RELEASE).put("token", token).put("seed", seed ?: JSONObject.NULL)
            .put("lan", lanJson())
            .put("vapid", runCatching { WebPushStore.vapidPublic(ctx) }.getOrNull() ?: JSONObject.NULL)
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
        // Battery saver (省電力モード): shown next to the battery level on the PC.
        val powerSave = ctx.getSystemService(android.os.PowerManager::class.java)?.isPowerSaveMode ?: false
        val st = StatFs(Environment.getDataDirectory().path)
        val am = ctx.getSystemService(AudioManager::class.java)
        val ringer = when (am.ringerMode) { AudioManager.RINGER_MODE_SILENT -> "サイレント"; AudioManager.RINGER_MODE_VIBRATE -> "バイブ"; else -> "着信音" }
        return JSONObject().put("battery", level).put("charging", plugged).put("powerSave", powerSave).put("net", net)
            .put("carrier", tm?.networkOperatorName?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
            .put("storageFree", st.availableBytes).put("storageTotal", st.totalBytes).put("ringer", ringer)
            .put("lan", lanJson())
            .put("sys", runCatching { SysControls.state(ctx) }.getOrNull() ?: JSONObject.NULL)
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

    // ---------- SMS / MMS / RCS ----------
    // content://sms holds plain SMS only. MMS and RCS messages live in content://mms,
    // so both providers must be merged or those conversations lose most of their history.
    /** Returns (body text, has non-text media part) for an MMS-provider entry.
     *  Carrier MMS almost always carries SMIL + a media part, while RCS chats are
     *  stored in this same provider as text-only entries — that distinction is what
     *  the sms/rcs/mms "kind" labels are based on (no public API separates them). */
    private fun mmsInfo(mid: Long): Pair<String, Boolean> {
        val texts = ArrayList<String>()
        var hasMedia = false
        runCatching {
            cr.query(Uri.parse("content://mms/part"), arrayOf("ct", "text"), "mid=?", arrayOf(mid.toString()), "seq ASC")?.use { c ->
                while (c.moveToNext()) {
                    val ct = c.getString(0) ?: ""
                    if (ct == "text/plain") c.getString(1)?.takeIf { it.isNotBlank() }?.let { t -> texts.add(t) }
                    else if (ct != "application/smil") hasMedia = true
                }
            }
        }
        val body = when {
            texts.isNotEmpty() -> texts.joinToString("\n")
            hasMedia -> "（添付ファイル）"
            else -> ""
        }
        return body to hasMedia
    }
    private fun mmsKind(hasMedia: Boolean) = if (hasMedia) "mms" else "rcs"
    private fun mmsAddress(mid: Long, outgoing: Boolean): String {
        // addr types (PduHeaders): FROM = 137, TO = 151
        var fallback = ""
        runCatching {
            cr.query(Uri.parse("content://mms/$mid/addr"), arrayOf("address", "type"), null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val a = c.getString(0) ?: continue
                    if (a == "insert-address-token") continue
                    if (fallback.isEmpty()) fallback = a
                    val type = c.getInt(1)
                    if (!outgoing && type == 137) return a
                    if (outgoing && type == 151) return a
                }
            }
        }
        return fallback
    }
    fun threads(): JSONArray {
        val byId = LinkedHashMap<Long, JSONObject>()
        val unreadCounts = HashMap<Long, Int>()
        if (!has(Manifest.permission.READ_SMS)) return JSONArray()
        runCatching {
            cr.query(Telephony.Sms.CONTENT_URI, arrayOf(Telephony.Sms.THREAD_ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.READ),
                null, null, "${Telephony.Sms.DATE} DESC")?.use { c ->
                var scanned = 0
                while (c.moveToNext() && scanned++ < 3000) {
                    val tid = c.getLong(0)
                    if (c.getInt(4) == 0) unreadCounts[tid] = (unreadCounts[tid] ?: 0) + 1
                    if (byId.containsKey(tid)) continue
                    val addr = c.getString(1) ?: ""
                    byId[tid] = JSONObject().put("id", tid.toString()).put("address", addr).put("name", contactName(addr) ?: JSONObject.NULL)
                        .put("snippet", c.getString(2) ?: "").put("time", c.getLong(3)).put("unread", c.getInt(4) == 0).put("kind", "sms")
                }
            }
        }
        // Merge MMS/RCS: threads made only of those never show up in content://sms at all,
        // and for mixed threads the newest message may be an MMS/RCS one.
        runCatching {
            cr.query(Telephony.Mms.CONTENT_URI, arrayOf(Telephony.Mms.THREAD_ID, Telephony.Mms._ID, Telephony.Mms.DATE, Telephony.Mms.READ, Telephony.Mms.MESSAGE_BOX),
                null, null, "${Telephony.Mms.DATE} DESC")?.use { c ->
                var scanned = 0
                val kindChecked = HashSet<Long>()
                while (c.moveToNext() && scanned++ < 1500) {
                    val tid = c.getLong(0); val mid = c.getLong(1); val time = c.getLong(2) * 1000
                    if (c.getInt(3) == 0) unreadCounts[tid] = (unreadCounts[tid] ?: 0) + 1
                    val cur = byId[tid]
                    val isNewest = cur == null || cur.getLong("time") < time
                    // The newest MMS-provider entry per thread also decides its kind
                    // (text-only -> rcs, with media -> mms); computed at most once per
                    // thread unless that entry becomes the thread's snippet.
                    var info: Pair<String, Boolean>? = null
                    if (isNewest || tid !in kindChecked) { info = mmsInfo(mid); kindChecked.add(tid) }
                    if (info != null && cur != null) {
                        val k = mmsKind(info.second)
                        val ck = cur.getString("kind")
                        if (ck == "sms" || (ck == "mms" && k == "rcs")) cur.put("kind", k)
                    }
                    if (!isNewest) continue
                    val addr = if (cur != null) cur.getString("address") else mmsAddress(mid, c.getInt(4) != Telephony.Mms.MESSAGE_BOX_INBOX)
                    byId[tid] = JSONObject().put("id", tid.toString()).put("address", addr).put("name", contactName(addr) ?: JSONObject.NULL)
                        .put("snippet", info!!.first).put("time", time).put("unread", c.getInt(3) == 0).put("kind", mmsKind(info.second))
                }
            }
        }
        // Merge the local sent log: messages sent from the PC are not written to
        // the provider by SmsManager (and our insert is refused on most devices),
        // so without this they would vanish from the thread list entirely.
        runCatching {
            val sent = SentLog.all(ctx)
            if (sent.isNotEmpty()) {
                val threads = byId.values.toList()
                for (t in threads) {
                    val addr = t.getString("address")
                    val latest = sent.filter { SentLog.sameNumber(it.address, addr) }.maxByOrNull { it.time } ?: continue
                    // Provider already shows it (snippet matches & times are close): nothing to fix.
                    if (t.getString("snippet") == latest.body && kotlin.math.abs(t.getLong("time") - latest.time) < 120_000) continue
                    if (latest.time > t.getLong("time")) { t.put("snippet", latest.body); t.put("time", latest.time) }
                }
                // Conversations that exist only in the sent log (provider has nothing).
                val orphanAddrs = sent.map { it.address }.distinct().filter { a -> threads.none { SentLog.sameNumber(it.getString("address"), a) } }
                for (a in orphanAddrs) {
                    val latest = sent.filter { SentLog.sameNumber(it.address, a) }.maxByOrNull { it.time } ?: continue
                    byId[Long.MIN_VALUE + latest.time] = JSONObject().put("id", "local:$a").put("address", a)
                        .put("name", contactName(a) ?: JSONObject.NULL).put("snippet", latest.body)
                        .put("time", latest.time).put("unread", false).put("kind", "sms")
                }
            }
        }
        // Authoritative unread state comes from the providers' READ flags.
        for ((tid, o) in byId) {
            val n = unreadCounts[tid] ?: 0
            o.put("unreadCount", n); o.put("unread", n > 0)
        }
        val arr = JSONArray()
        byId.values.sortedByDescending { it.getLong("time") }.take(60).forEach { arr.put(it) }
        return arr
    }

    /** Marks every unread SMS/MMS in a thread as read in the providers and
     *  returns how many rows were actually updated. Android only honours
     *  provider writes from the default SMS app (plus some OEM builds), so on
     *  most devices this updates 0 rows and the stock messaging app keeps its
     *  unread state; callers must not fake success. */
    fun markRead(threadId: String): Int {
        if (threadId.startsWith("local:") || !has(Manifest.permission.READ_SMS)) return 0
        var n = 0
        runCatching {
            val cv = ContentValues().apply { put(Telephony.Sms.READ, 1); put(Telephony.Sms.SEEN, 1) }
            n += cr.update(Telephony.Sms.CONTENT_URI, cv, "${Telephony.Sms.THREAD_ID}=? AND ${Telephony.Sms.READ}=0", arrayOf(threadId))
        }
        runCatching {
            val cv = ContentValues().apply { put(Telephony.Mms.READ, 1) }
            n += cr.update(Telephony.Mms.CONTENT_URI, cv, "${Telephony.Mms.THREAD_ID}=? AND ${Telephony.Mms.READ}=0", arrayOf(threadId))
        }
        return n
    }
    fun sms(threadId: String): JSONArray {
        // Synthetic thread that exists only in the local sent log.
        if (threadId.startsWith("local:")) {
            val addr = threadId.removePrefix("local:")
            val out = JSONArray()
            SentLog.all(ctx).filter { SentLog.sameNumber(it.address, addr) }.sortedBy { it.time }.takeLast(150).forEach { e ->
                out.put(JSONObject().put("id", "s${e.time}").put("body", e.body).put("time", e.time).put("mine", true).put("kind", "sms").put("read", true))
            }
            return out
        }
        val list = ArrayList<JSONObject>()
        if (!has(Manifest.permission.READ_SMS)) return JSONArray()
        runCatching {
            cr.query(Telephony.Sms.CONTENT_URI, arrayOf(Telephony.Sms._ID, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.READ),
                "${Telephony.Sms.THREAD_ID}=?", arrayOf(threadId), "${Telephony.Sms.DATE} DESC")?.use { c ->
                while (c.moveToNext() && list.size < 1000) {
                    list.add(JSONObject().put("id", c.getString(0)).put("body", c.getString(1) ?: "").put("time", c.getLong(2))
                        .put("mine", c.getInt(3) != Telephony.Sms.MESSAGE_TYPE_INBOX).put("kind", "sms").put("read", c.getInt(4) != 0))
                }
            }
        }
        runCatching {
            cr.query(Telephony.Mms.CONTENT_URI, arrayOf(Telephony.Mms._ID, Telephony.Mms.DATE, Telephony.Mms.MESSAGE_BOX, Telephony.Mms.READ),
                "${Telephony.Mms.THREAD_ID}=?", arrayOf(threadId), "${Telephony.Mms.DATE} DESC")?.use { c ->
                while (c.moveToNext() && list.size < 2000) {
                    val mid = c.getLong(0)
                    val (body, media) = mmsInfo(mid)
                    list.add(JSONObject().put("id", "m$mid").put("body", body).put("time", c.getLong(1) * 1000)
                        .put("mine", c.getInt(2) != Telephony.Mms.MESSAGE_BOX_INBOX).put("kind", mmsKind(media)).put("read", c.getInt(3) != 0))
                }
            }
        }
        // Merge local sent-log entries for this thread's address that the
        // provider does not have (dedup: same body, outgoing, within 2 minutes
        // of a provider copy counts as the same message).
        runCatching {
            val addr = threadAddress(threadId)
            if (addr != null) {
                for (e in SentLog.all(ctx)) {
                    if (!SentLog.sameNumber(e.address, addr)) continue
                    val dup = list.any { it.getBoolean("mine") && it.getString("body") == e.body && kotlin.math.abs(it.getLong("time") - e.time) <= 120_000 }
                    if (!dup) list.add(JSONObject().put("id", "s${e.time}").put("body", e.body).put("time", e.time).put("mine", true).put("kind", "sms").put("read", true))
                }
            }
        }
        list.sortBy { it.getLong("time") }
        return JSONArray(list.takeLast(150))
    }
    /** Best-effort address lookup for a provider thread id (SMS first, then MMS). */
    private fun threadAddress(threadId: String): String? {
        runCatching {
            cr.query(Telephony.Sms.CONTENT_URI, arrayOf(Telephony.Sms.ADDRESS), "${Telephony.Sms.THREAD_ID}=?", arrayOf(threadId), "${Telephony.Sms.DATE} DESC")?.use { c ->
                if (c.moveToFirst()) return c.getString(0)
            }
        }
        runCatching {
            cr.query(Telephony.Mms.CONTENT_URI, arrayOf(Telephony.Mms._ID, Telephony.Mms.MESSAGE_BOX), "${Telephony.Mms.THREAD_ID}=?", arrayOf(threadId), "${Telephony.Mms.DATE} DESC")?.use { c ->
                if (c.moveToFirst()) return mmsAddress(c.getLong(0), c.getInt(1) != Telephony.Mms.MESSAGE_BOX_INBOX)
            }
        }
        return null
    }
    fun threadIdFor(address: String): String? = runCatching { Telephony.Threads.getOrCreateThreadId(ctx, address).toString() }.getOrNull()
    fun sendSms(to: String, body: String): Boolean {
        if (!has(Manifest.permission.SEND_SMS) || to.isBlank() || body.isBlank()) return false
        val sent = runCatching {
            val sm = ctx.getSystemService(SmsManager::class.java)
            sm.sendMultipartTextMessage(to, null, sm.divideMessage(body), null, null)
            true
        }.getOrDefault(false)
        if (!sent) return false
        // SmsManager never records what it sent. Try to write the sent copy to
        // the provider (works when this app may write, e.g. as default SMS app;
        // refused silently on most devices) and always keep a local record so
        // the message shows up in Tsunagu's own history either way.
        runCatching {
            val values = ContentValues().apply {
                put(Telephony.Sms.ADDRESS, to)
                put(Telephony.Sms.BODY, body)
                put(Telephony.Sms.DATE, System.currentTimeMillis())
                put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_SENT)
                put(Telephony.Sms.READ, 1)
                threadIdFor(to)?.toLongOrNull()?.let { put(Telephony.Sms.THREAD_ID, it) }
            }
            cr.insert(Telephony.Sms.Sent.CONTENT_URI, values)
        }
        SentLog.add(ctx, to, body)
        return true
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
        // Android 14+: with "selected photos" (partial) access, READ_MEDIA_IMAGES/VIDEO stay
        // denied and READ_MEDIA_VISUAL_USER_SELECTED is granted instead — the selected items
        // are still readable, so treat it as access or nothing ever shows up on the PC.
        val partial = Build.VERSION.SDK_INT >= 34 && has(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        val canImg = has(Manifest.permission.READ_MEDIA_IMAGES) || partial; val canVid = has(Manifest.permission.READ_MEDIA_VIDEO) || partial
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

    // ---------- location （探す） ----------
    /** Current position for the PC "探す" screen. Uses a fresh last-known fix
     *  when available, otherwise requests one current fix (9s timeout) and
     *  falls back to the stale last-known fix. Errors are explicit:
     *  "permission" (no location permission) / "unavailable" (no fix). */
    @SuppressLint("MissingPermission")
    suspend fun location(): JSONObject {
        val fine = has(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = has(Manifest.permission.ACCESS_COARSE_LOCATION)
        if (!fine && !coarse) return JSONObject().put("error", "permission")
        val lm = ctx.getSystemService(LocationManager::class.java)
        var best: Location? = null
        runCatching {
            for (p in lm.getProviders(true)) {
                val l = runCatching { lm.getLastKnownLocation(p) }.getOrNull() ?: continue
                val cur = best
                if (cur == null || l.time > cur.time) best = l
            }
        }
        val b = best
        if (b != null && System.currentTimeMillis() - b.time < 60_000) return locJson(b)
        val fresh = runCatching { withTimeoutOrNull(9_000) { currentFix(lm, fine) } }.getOrNull()
        val use = fresh ?: b
        return if (use != null) locJson(use) else JSONObject().put("error", "unavailable")
    }
    private fun locJson(l: Location) = JSONObject().put("lat", l.latitude).put("lng", l.longitude)
        .put("acc", if (l.hasAccuracy()) l.accuracy.toDouble() else JSONObject.NULL).put("time", l.time)
    @SuppressLint("MissingPermission")
    private suspend fun currentFix(lm: LocationManager, fine: Boolean): Location? = suspendCancellableCoroutine { cont ->
        val provider = when {
            fine && runCatching { lm.isProviderEnabled(LocationManager.GPS_PROVIDER) }.getOrDefault(false) -> LocationManager.GPS_PROVIDER
            runCatching { lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) }.getOrDefault(false) -> LocationManager.NETWORK_PROVIDER
            else -> null
        }
        if (provider == null) { cont.resume(null); return@suspendCancellableCoroutine }
        runCatching {
            lm.getCurrentLocation(provider, null, ctx.mainExecutor) { loc -> if (cont.isActive) cont.resume(loc) }
        }.onFailure { if (cont.isActive) cont.resume(null) }
    }

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
