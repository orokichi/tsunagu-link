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

/** One page of a conversation plus the reason it may be empty. */
data class SmsPage(val items: JSONArray, val hasMore: Boolean, val error: String?)

class Features(private val ctx: Context) {
    companion object {
        /** 「使用中のみ」でも「常に」でも、位置情報の許可があるか. */
        fun locGranted(c: Context): Boolean =
            c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            c.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

        /** 「常に許可」(ACCESS_BACKGROUND_LOCATION): アプリを開いていなくても位置を取れる. */
        fun locAlways(c: Context): Boolean =
            Build.VERSION.SDK_INT >= 29 && c.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

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
    fun notifications(): Pair<JSONArray, String?> {
        val arr = JSONArray()
        val l = NotifListener.instance ?: return arr to "off"
        l.items().forEach { arr.put(it) }
        return arr to null
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
    private val mmsCache = HashMap<Long, Pair<String, Boolean>>()
    private fun mmsInfo(mid: Long): Pair<String, Boolean> {
        mmsCache[mid]?.let { return it }
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
        // PDU parts never change after delivery, so one lookup per message is enough.
        if (mmsCache.size > 400) mmsCache.clear()
        return (body to hasMedia).also { mmsCache[mid] = it }
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
        byId.values.sortedByDescending { it.optLong("time") }.take(60).forEach { arr.put(it) }
        return arr
    }

    /** Thread list plus the reason it is empty ("permission" / a query error), so
     *  the PC can say why instead of showing a blank list. */
    fun threadsSafe(): Pair<JSONArray, String?> {
        if (!has(Manifest.permission.READ_SMS)) return JSONArray() to "permission"
        return runCatching<Pair<JSONArray, String?>> { threads() to null }.getOrElse { JSONArray() to (it.message ?: it.toString()) }
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
    /**
     * One page of a conversation. [before] is the oldest timestamp the PC already
     * holds (0 = the newest page), so older history is fetched on demand: a long
     * conversation then never has to travel as one huge message, and a query that
     * fails on one provider can no longer wipe out the whole answer.
     * [error] is non-null when something failed, so the PC can show the reason.
     */
    fun smsPage(threadId: String, before: Long, limit: Int): SmsPage {
        val cap = limit.coerceIn(1, 300)
        // Synthetic thread that exists only in the local sent log.
        if (threadId.startsWith("local:")) {
            val addr = threadId.removePrefix("local:")
            val all = SentLog.all(ctx).filter { SentLog.sameNumber(it.address, addr) && (before <= 0 || it.time <= before) }
                .sortedByDescending { it.time }
            val out = JSONArray()
            all.take(cap).sortedBy { it.time }.forEach { e -> runCatching {
                out.put(JSONObject().put("id", "s${e.time}").put("body", e.body).put("time", e.time).put("mine", true).put("kind", "sms").put("read", true))
            } }
            return SmsPage(out, all.size > cap, null)
        }
        if (!has(Manifest.permission.READ_SMS)) return SmsPage(JSONArray(), false, "permission")
        val rows = ArrayList<JSONObject>()
        var err: String? = null
        runCatching { rows.addAll(smsRows(threadId, before, cap + 1)) }
            .onFailure { err = it.message ?: it.toString() }
        runCatching { rows.addAll(mmsRows(threadId, before, cap + 1)) }
            .onFailure { if (err == null) err = it.message ?: it.toString() }
        // Messages sent from the PC are not always written to the provider, so the
        // local log is merged into the newest page (deduped by body and time).
        if (before <= 0) runCatching { mergeSentLog(threadId, rows) }
        val byId = LinkedHashMap<String, JSONObject>()
        rows.forEach { o -> o.optString("id").takeIf { it.isNotEmpty() }?.let { id -> byId[id] = o } }
        val desc = byId.values.toList().sortedByDescending { it.optLong("time") }
        val page = desc.take(cap).sortedBy { it.optLong("time") }
        return SmsPage(JSONArray(page), desc.size > cap, err)
    }

    private fun smsRows(threadId: String, before: Long, cap: Int): List<JSONObject> {
        val out = ArrayList<JSONObject>()
        val args = ArrayList<String>().apply { add(threadId) }
        val sel = StringBuilder("${Telephony.Sms.THREAD_ID}=?")
        if (before > 0) { sel.append(" AND ${Telephony.Sms.DATE}<=?"); args.add(before.toString()) }
        val c = cr.query(Telephony.Sms.CONTENT_URI,
            arrayOf(Telephony.Sms._ID, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.READ),
            sel.toString(), args.toTypedArray(), "${Telephony.Sms.DATE} DESC") ?: return out
        c.use {
            while (out.size < cap && it.moveToNext()) {
                val time = if (it.isNull(2)) 0L else it.getLong(2)
                val id = if (it.isNull(0)) "s$time" else it.getString(0) ?: "s$time"
                runCatching {
                    out.add(JSONObject().put("id", id).put("body", if (it.isNull(1)) "" else it.getString(1) ?: "")
                        .put("time", time)
                        .put("mine", !it.isNull(3) && it.getInt(3) != Telephony.Sms.MESSAGE_TYPE_INBOX)
                        .put("kind", "sms").put("read", !it.isNull(4) && it.getInt(4) != 0))
                }
            }
        }
        return out
    }

    private fun mmsRows(threadId: String, before: Long, cap: Int): List<JSONObject> {
        val out = ArrayList<JSONObject>()
        val args = ArrayList<String>().apply { add(threadId) }
        val sel = StringBuilder("${Telephony.Mms.THREAD_ID}=?")
        // MMS dates are seconds: the cursor bound needs the same unit (plus one
        // second of slack, so a page boundary never drops a message).
        if (before > 0) { sel.append(" AND ${Telephony.Mms.DATE}<=?"); args.add((before / 1000 + 1).toString()) }
        val c = cr.query(Telephony.Mms.CONTENT_URI,
            arrayOf(Telephony.Mms._ID, Telephony.Mms.DATE, Telephony.Mms.MESSAGE_BOX, Telephony.Mms.READ),
            sel.toString(), args.toTypedArray(), "${Telephony.Mms.DATE} DESC") ?: return out
        c.use {
            while (out.size < cap && it.moveToNext()) {
                if (it.isNull(0)) continue
                val mid = it.getLong(0)
                runCatching {
                    val (body, media) = mmsInfo(mid)
                    out.add(JSONObject().put("id", "m$mid").put("body", body)
                        .put("time", (if (it.isNull(1)) 0L else it.getLong(1)) * 1000)
                        .put("mine", !it.isNull(2) && it.getInt(2) != Telephony.Mms.MESSAGE_BOX_INBOX)
                        .put("kind", mmsKind(media)).put("read", !it.isNull(3) && it.getInt(3) != 0))
                }
            }
        }
        return out
    }

    /** Merges the local sent log for [threadId] into [rows] (same body within two
     *  minutes of a provider copy counts as the same message). */
    private fun mergeSentLog(threadId: String, rows: ArrayList<JSONObject>) {
        val addr = threadAddress(threadId) ?: return
        for (e in SentLog.all(ctx)) {
            if (!SentLog.sameNumber(e.address, addr)) continue
            val dup = rows.any { it.optBoolean("mine") && it.optString("body") == e.body && kotlin.math.abs(it.optLong("time") - e.time) <= 120_000 }
            if (!dup) rows.add(JSONObject().put("id", "s${e.time}").put("body", e.body).put("time", e.time).put("mine", true).put("kind", "sms").put("read", true))
        }
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
    /**
     * Current position for the PC "探す" screen.
     *
     * Android only lets a background app read the location when it either holds
     * "常に許可" (ACCESS_BACKGROUND_LOCATION) or runs a location foreground service
     * ([fgLocation], see LinkService). Errors are explicit so the PC can explain
     * what to do instead of failing silently:
     *   permission      → no location permission at all
     *   foreground_only → 使用中のみ granted; needs the app open or 常に許可
     *   disabled        → the phone's location switch is off
     *   unavailable     → allowed, but no fix could be obtained
     */
    @SuppressLint("MissingPermission")
    suspend fun location(fgLocation: Boolean): JSONObject {
        val fine = has(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = has(Manifest.permission.ACCESS_COARSE_LOCATION)
        val always = locAlways(ctx)
        if (!fine && !coarse) return locErr("permission", always)
        val lm = ctx.getSystemService(LocationManager::class.java)
        if (!runCatching { lm.isLocationEnabled }.getOrDefault(true)) return locErr("disabled", always)
        val live = always || fgLocation
        var best: Location? = null
        runCatching {
            for (p in lm.getProviders(true)) {
                val l = runCatching { lm.getLastKnownLocation(p) }.getOrNull() ?: continue
                val cur = best
                if (cur == null || l.time > cur.time) best = l
            }
        }
        val b = best
        if (b != null && System.currentTimeMillis() - b.time < 90_000) return locJson(b, always, fgLocation)
        // Only ask for a fresh fix when the system will actually deliver one; from
        // the background with 使用中のみ it silently returns nothing (or throws).
        val fresh = if (live) runCatching { withTimeoutOrNull(12_000) { currentFix(lm, fine) } }.getOrNull() else null
        val use = fresh ?: b
        if (use == null) return locErr(if (live) "unavailable" else "foreground_only", always)
        return locJson(use, always, fgLocation)
    }
    private fun locErr(reason: String, always: Boolean) = JSONObject().put("error", reason)
        .put("mode", if (always) "always" else "while_in_use").put("always", always)
    private fun locJson(l: Location, always: Boolean, fgLocation: Boolean) = JSONObject()
        .put("lat", l.latitude).put("lng", l.longitude)
        .put("acc", if (l.hasAccuracy()) l.accuracy.toDouble() else JSONObject.NULL).put("time", l.time)
        .put("mode", if (always) "always" else "while_in_use").put("always", always).put("fg", fgLocation)
        .put("age", System.currentTimeMillis() - l.time)
    @SuppressLint("MissingPermission")
    private suspend fun currentFix(lm: LocationManager, fine: Boolean): Location? = suspendCancellableCoroutine { cont ->
        val provider = when {
            fine && runCatching { lm.isProviderEnabled(LocationManager.GPS_PROVIDER) }.getOrDefault(false) -> LocationManager.GPS_PROVIDER
            runCatching { lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) }.getOrDefault(false) -> LocationManager.NETWORK_PROVIDER
            else -> null
        }
        if (provider == null) { cont.resume(null); return@suspendCancellableCoroutine }
        val ctl = android.os.CancellationSignal()
        // A timed-out request must not keep the GPS warm: cancel it on timeout.
        cont.invokeOnCancellation { runCatching { ctl.cancel() } }
        runCatching {
            lm.getCurrentLocation(provider, ctl, ctx.mainExecutor) { loc -> if (cont.isActive) cont.resume(loc) }
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
