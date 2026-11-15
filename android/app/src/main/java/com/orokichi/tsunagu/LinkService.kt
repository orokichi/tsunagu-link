package com.orokichi.tsunagu

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.BatteryManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Telephony
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStream
import kotlin.coroutines.resume

data class Transfer(val id: String, val name: String, val size: Long, val done: Long, val incoming: Boolean, val state: String)

class LinkService : Service() {

    companion object {
        @Volatile var instance: LinkService? = null
        private val _status = MutableStateFlow("idle")
        val status: StateFlow<String> = _status
        private val _transfers = MutableStateFlow<List<Transfer>>(emptyList())
        val transfers: StateFlow<List<Transfer>> = _transfers
        /** Which transport the live connection uses: "lan" (direct, same network) or "cloud" (PeerJS). */
        private val _via = MutableStateFlow("")
        val via: StateFlow<String> = _via
        @Volatile var lanPort: Int = 0
        @Volatile var lastClip: String = ""

        fun start(c: Context) {
            c.startForegroundService(Intent(c, LinkService::class.java))
        }
        fun stop(c: Context) { c.stopService(Intent(c, LinkService::class.java)) }
        const val ACTION_SEND_URIS = "com.orokichi.tsunagu.SEND_URIS"
        const val ACTION_SEND_TEXT = "com.orokichi.tsunagu.SEND_TEXT"
        const val ACTION_KICK = "com.orokichi.tsunagu.KICK"
        const val EXTRA_TEXT = "text"
    }

    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default + kotlinx.coroutines.CoroutineExceptionHandler { _, e -> android.util.Log.w("Tsunagu", "handler", e) })
    private var web: WebView? = null
    private var ready = false
    private lateinit var features: Features
    private val incoming = HashMap<String, Pair<Uri, OutputStream>>()
    private val incomingMeta = HashMap<String, Transfer>()
    private var infoJob: Job? = null
    private val fileQueue = kotlinx.coroutines.channels.Channel<Pair<JSONObject, String>>(kotlinx.coroutines.channels.Channel.UNLIMITED)
    // ---- LAN direct connection ----
    private var lanServer: LanServer? = null
    @Volatile private var activeVia: String? = null
    @Volatile private var lanAnswer: String? = null
    @Volatile private var lanLatch: java.util.concurrent.CountDownLatch? = null
    private val lanBusy = java.util.concurrent.atomic.AtomicBoolean(false)
    private var ringer: Ringer? = null
    private var vibrator: android.os.Vibrator? = null
    private val vibStop = Runnable { stopVibrate() }
    // ---- Explorer uploads (PC -> a chosen folder on the phone) ----
    private class FsUp(val dir: String, val file: java.io.File, val out: OutputStream, val size: Long) { var done: Long = 0 }
    private val fsUploads = HashMap<String, FsUp>()
    private val net = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            main.post { js("B.kick()") }
            // The LAN address may have changed with the network: push fresh info
            // (which carries the current LAN endpoints) to the connected PC.
            if (connected()) scope.launch { delay(800); sendInfo() }
        }
    }
    private val battery = object : android.content.BroadcastReceiver() {
        var lastSig = ""
        override fun onReceive(c: Context, i: Intent) {
            // Push on plug/unplug and charging-state changes too, not only on 1%
            // level steps; identical states are deduped so this never spams.
            val sig = "${i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)}/${i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)}/${i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)}"
            if (sig != lastSig) { lastSig = sig; if (connected()) sendInfo() }
        }
    }

    // ---- Realtime SMS/MMS: watch both providers and push fresh threads/history ----
    @Volatile private var watchedThread: String? = null
    private var smsPushJob: Job? = null
    private val smsObserver = object : android.database.ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) = scheduleSmsPush()
        override fun onChange(selfChange: Boolean, uri: Uri?) = scheduleSmsPush()
    }
    private fun scheduleSmsPush() {
        if (!connected()) return
        smsPushJob?.cancel()
        smsPushJob = scope.launch {
            delay(700) // bursts of provider writes collapse into one push
            if (!connected()) return@launch
            // The conversation the PC is looking at counts as read: keep the
            // providers' READ flags in step so its unread badge clears too.
            watchedThread?.let { runCatching { features.markRead(it) } }
            send(msg("threads", "items" to features.threads()))
            watchedThread?.let { send(msg("sms", "threadId" to it, "items" to features.sms(it))) }
        }
    }

    fun connected() = _status.value == "connected"
    fun rewatchMedia() = main.post { features.unwatchMedia(); features.watchMedia() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        features = Features(this)
        startForeground(1, fgNotif("接続を準備中…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        createWeb()
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(net)
        registerReceiver(battery, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        runCatching {
            contentResolver.registerContentObserver(Telephony.Sms.CONTENT_URI, true, smsObserver)
            contentResolver.registerContentObserver(Telephony.Mms.CONTENT_URI, true, smsObserver)
        }
        features.watchMedia()
        scope.launch { for ((m, via) in fileQueue) runCatching { handle(m, via) } }
        // LAN signaling endpoint: lets a paired PC on the same Wi-Fi connect
        // directly (WebRTC) without the cloud. Auth = SHA-256 of the stored
        // pairing token; only answers while this service runs.
        lanServer = LanServer(
            authHashes = { val t = Prefs.token(this); if (t.isEmpty()) emptySet() else setOf(sha256Hex(t)) },
            deviceName = { features.hello(Prefs.token(this)).optString("name") },
            onOffer = { sdp -> lanOffer(sdp) },
        ).also { it.start(); lanPort = it.port }
    }

    /** Hands an SDP offer from the LAN server to the WebView bridge and waits for its answer. */
    private fun lanOffer(sdp: String): String? {
        if (!ready || !lanBusy.compareAndSet(false, true)) return null
        try {
            val latch = java.util.concurrent.CountDownLatch(1)
            lanLatch = latch; lanAnswer = null
            js("Lan.offer(${JSONObject.quote(sdp)})")
            val ok = latch.await(9, java.util.concurrent.TimeUnit.SECONDS)
            return if (ok) lanAnswer else null
        } finally {
            lanBusy.set(false)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SEND_URIS -> {
                val uris = ArrayList<Uri>()
                intent.clipData?.let { cd -> for (i in 0 until cd.itemCount) cd.getItemAt(i).uri?.let { uris.add(it) } }
                if (uris.isEmpty()) intent.data?.let { uris.add(it) }
                scope.launch { uris.forEach { sendUri(it) } }
            }
            ACTION_SEND_TEXT -> intent.getStringExtra(EXTRA_TEXT)?.let { sendClip(it) }
            ACTION_KICK -> main.post { js("B.kick()") }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        instance = null
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(net) }
        runCatching { unregisterReceiver(battery) }
        runCatching { contentResolver.unregisterContentObserver(smsObserver) }
        features.unwatchMedia()
        lanServer?.stop(); lanServer = null; lanPort = 0
        activeVia = null; _via.value = ""
        ringer?.stop()
        stopVibrate()
        js("B.stop()")
        web?.destroy(); web = null
        scope.cancel()
        _status.value = "idle"
        super.onDestroy()
    }

    // ---------------- WebView / PeerJS bridge ----------------
    inner class Bridge {
        @JavascriptInterface fun onReady() { main.post { ready = true; boot() } }
        @JavascriptInterface fun onStatus(s: String) { main.post { if (activeVia != "lan") setStatus(s) } }
        @JavascriptInterface fun onMessage(json: String, via: String) {
            val m = runCatching { JSONObject(json) }.getOrNull() ?: return
            val t = m.optString("t")
            // File transfers (both directions, incl. explorer uploads) must stay
            // strictly ordered, so they go through the serial file queue.
            if (t.startsWith("file_") || t.startsWith("fs_put")) fileQueue.trySend(m to via) else scope.launch { handle(m, via) }
        }
        @JavascriptInterface fun onLanStatus(s: String) {
            main.post {
                // The active LAN transport went away: fall back to the cloud.
                if (s == "closed" && activeVia == "lan") {
                    activeVia = null; _via.value = ""
                    infoJob?.cancel()
                    setStatus("connecting")
                    js("B.setActive('cloud')")
                }
            }
        }
        @JavascriptInterface fun onLanAnswer(sdp: String) {
            lanAnswer = sdp.ifEmpty { null }
            lanLatch?.countDown()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWeb() {
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            addJavascriptInterface(Bridge(), "TsunaguNative")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            }
            onResume(); resumeTimers()
            loadUrl("https://appassets.androidplatform.net/assets/bridge.html")
        }
    }

    private fun boot() {
        val code = Prefs.code(this) ?: run { stopSelf(); return }
        js("B.start(${JSONObject.quote(code)}, ${JSONObject.quote(features.hello(Prefs.token(this)).toString())})")
    }

    private fun setStatus(s: String) {
        val v = when {
            s == "connected" -> "connected"
            s == "idle" -> "idle"
            s == "disconnected" -> { infoJob?.cancel(); "connecting" }
            else -> if (_status.value == "connected" && s.startsWith("error")) "connecting" else "connecting"
        }
        if (v == _status.value) return
        _status.value = v
        refreshFg()
    }

    private fun refreshFg() {
        val text = if (_status.value == "connected") {
            val route = when (activeVia) { "lan" -> "（同じネットワークで直接接続）"; "cloud" -> "（クラウド経由）"; else -> "" }
            "${Prefs.pcName(this)} と接続中$route"
        } else "PC を探しています…"
        getSystemService(NotificationManager::class.java).notify(1, fgNotif(text))
    }

    private fun js(code: String, cb: ((String) -> Unit)? = null) {
        main.post { if (ready) web?.evaluateJavascript(code) { r -> cb?.invoke(r ?: "") } else cb?.invoke("-1") }
    }

    fun send(o: JSONObject) { if (connected() || o.optString("t") == "hello") js("B.send(${JSONObject.quote(o.toString())})") }

    /** Sends and waits while the data channel buffer is large (backpressure for files). */
    private suspend fun sendAwait(o: JSONObject): Boolean {
        val r = suspendCancellableCoroutine<String> { c -> js("B.send(${JSONObject.quote(o.toString())})") { c.resume(it) } }
        var buf = r.toLongOrNull() ?: -1
        if (buf < 0) return false
        while (buf > 3_000_000) {
            delay(40)
            buf = suspendCancellableCoroutine<String> { c -> js("B.buffered()") { c.resume(it) } }.toLongOrNull() ?: -1
            if (buf < 0) return false
        }
        return true
    }

    fun msg(t: String, vararg kv: Pair<String, Any?>) = JSONObject().put("t", t).also { o -> kv.forEach { o.put(it.first, it.second ?: JSONObject.NULL) } }

    // ---------------- Incoming messages ----------------
    private suspend fun handle(m: JSONObject, via: String = "cloud") {
        when (m.optString("t")) {
            "welcome" -> {
                val previousToken = Prefs.token(this)
                val newToken = m.optString("token")
                // A fresh token means the PC re-paired (or the pairing was
                // reset): subscriptions registered under the old token must
                // not receive pushes any more.
                if (previousToken.isNotEmpty() && previousToken != newToken) {
                    WebPushStore.clearToken(this, previousToken)
                }
                Prefs.setToken(this, newToken, m.optString("pc", "PC"))
                activeVia = via; _via.value = via
                js("B.setActive(${JSONObject.quote(via)})")
                withContext(Dispatchers.Main) { setStatus("connected"); refreshFg() }
                sendInfo(); send(msg("notifs", "items" to features.notifications()))
                infoJob?.cancel()
                infoJob = scope.launch { while (isActive) { delay(60_000); sendInfo() } }
            }
            "push_subscribe" -> {
                // The PC hands over its browser PushSubscription so the phone
                // can reach it with Web Push while the Tsunagu page is closed.
                // Stored against the pairing token that owns this connection.
                val token = m.optString("pcToken").ifEmpty { Prefs.token(this) }
                val sub = m.optJSONObject("subscription")
                val ok = sub != null && withContext(Dispatchers.IO) {
                    runCatching { WebPushStore.saveSubscription(this@LinkService, token, sub) }.getOrDefault(false)
                }
                send(msg("push_state", "subscribed" to ok, "endpoint" to (sub?.optString("endpoint") ?: "")))
            }
            "push_unsubscribe" -> {
                val token = m.optString("pcToken").ifEmpty { Prefs.token(this) }
                val endpoint = m.optString("endpoint")
                withContext(Dispatchers.IO) {
                    runCatching { WebPushStore.removeSubscription(this@LinkService, token, endpoint) }
                }
                send(msg("push_state", "subscribed" to false, "endpoint" to endpoint))
            }
            "get" -> when (m.optString("what")) {
                "info" -> sendInfo()
                "notifs" -> send(msg("notifs", "items" to features.notifications()))
                "media" -> send(msg("media", "state" to features.mediaState()))
                "threads" -> send(msg("threads", "items" to features.threads()))
                "sms" -> m.optString("threadId").let { watchedThread = it; send(msg("sms", "threadId" to it, "items" to features.sms(it))) }
                "calls" -> send(msg("calls", "items" to features.calls()))
                "photos" -> {
                    val off = m.optInt("offset", 0)
                    val (items, more) = features.photos(off, 48)
                    send(msg("photos", "items" to items, "offset" to off, "hasMore" to more))
                }
                "location" -> {
                    val loc = features.location()
                    val o = msg("location")
                    loc.keys().forEach { k -> o.put(k, loc.get(k)) }
                    send(o)
                }
                "fs" -> sendFsList(m.optString("path"))
            }
            "mark_read" -> {
                val tid = m.optString("threadId")
                if (tid.isNotEmpty()) {
                    runCatching { features.markRead(tid) }
                    send(msg("threads", "items" to features.threads()))
                    send(msg("sms", "threadId" to tid, "items" to features.sms(tid)))
                }
            }
            "watch" -> watchedThread = m.optString("threadId").ifEmpty { null }
            "vibrate" -> withContext(Dispatchers.Main) {
                if (m.optBoolean("on", true)) startVibrate() else stopVibrate()
            }
            "fs_get" -> Explorer.resolve(m.optString("path"))?.takeIf { it.isFile }?.let { sendFile(it) }
            "fs_delete" -> {
                val path = m.optString("path")
                val ok = Explorer.delete(path)
                toast(if (ok) "削除しました" else "削除できませんでした")
                sendFsList(parentOf(path))
            }
            "fs_rename" -> {
                val path = m.optString("path")
                val ok = Explorer.rename(path, m.optString("name"))
                toast(if (ok) "名前を変更しました" else "名前を変更できませんでした")
                sendFsList(parentOf(path))
            }
            "fs_mkdir" -> {
                val dir = m.optString("path")
                val ok = Explorer.mkdir(dir, m.optString("name"))
                toast(if (ok) "フォルダを作成しました" else "フォルダを作成できませんでした")
                sendFsList(dir)
            }
            "fs_perm" -> withContext(Dispatchers.Main) {
                val opened = runCatching {
                    startActivity(Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true
                }.getOrElse {
                    runCatching { startActivity(Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true }.getOrDefault(false)
                }
                toast(if (opened) "スマホで「すべてのファイルへのアクセス」を許可してください" else "設定画面を開けませんでした")
            }
            "fs_put_start" -> startFsUpload(m)
            "fs_put_chunk" -> fsUploads[m.optString("id")]?.let { up ->
                val bytes = Base64.decode(m.optString("d"), Base64.NO_WRAP)
                withContext(Dispatchers.IO) { up.out.write(bytes) }
                up.done += bytes.size
            }
            "fs_put_end" -> finishFsUpload(m.optString("id"))
            "notif_dismiss" -> NotifListener.instance?.dismiss(m.optString("key"))
            "notif_reply" -> NotifListener.instance?.reply(m.optString("key"), m.optString("text"))?.let { ok -> toast(if (ok) "返信しました" else "返信できませんでした") }
            "notif_action" -> NotifListener.instance?.action(m.optString("key"), m.optInt("index"))
            "media_cmd" -> features.mediaCommand(m.optString("cmd"))
            "sms_send" -> {
                val ok = features.sendSms(m.optString("to"), m.optString("body"))
                toast(if (ok) "SMS を送信しました" else "SMS を送信できませんでした（権限を確認してください）")
                m.optString("threadId").takeIf { it.isNotEmpty() && it != "new" }?.let { watchedThread = it }
                delay(1500)
                send(msg("threads", "items" to features.threads()))
                m.optString("threadId").takeIf { it.isNotEmpty() && it != "new" }?.let { send(msg("sms", "threadId" to it, "items" to features.sms(it))) }
            }
            "dial" -> toast(if (features.dial(m.optString("number"))) "スマホから発信しています" else "発信できませんでした（電話の権限を確認してください）")
            "call_end" -> features.endCall()
            "clip" -> m.optString("text").let { t ->
                lastClip = t
                withContext(Dispatchers.Main) { getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Tsunagu", t)) }
            }
            "ring" -> withContext(Dispatchers.Main) {
                if (m.optBoolean("on", true)) { stopVibrate(); ringer?.stop(); ringer = Ringer(this@LinkService).also { it.start() }; toast("スマホを鳴らしています") } else { ringer?.stop(); stopVibrate() }
            }
            "open_url" -> features.openUrl(m.optString("url"))
            "photo_get" -> features.photoUri(m.optString("id"))?.let { sendUri(it) }
            "file_start" -> startIncoming(m)
            "file_chunk" -> incoming[m.optString("id")]?.let { (_, out) ->
                val bytes = Base64.decode(m.optString("d"), Base64.NO_WRAP)
                withContext(Dispatchers.IO) { out.write(bytes) }
                incomingMeta[m.optString("id")]?.let { t -> updateTransfer(t.copy(done = t.done + bytes.size)) }
            }
            "file_end" -> finishIncoming(m.optString("id"))
        }
    }

    fun toast(text: String) = send(msg("toast", "text" to text))

    fun sendInfo() { if (connected()) send(msg("info", "info" to features.info())) }

    fun sendClip(text: String) {
        if (text.isBlank()) return
        lastClip = text
        send(msg("clip", "text" to text))
    }

    fun onNotification(item: JSONObject, fresh: Boolean) {
        if (fresh && !connected()) {
            // The PC page is not live: deliver through Web Push instead, so
            // the two paths never show the same notification twice. Sending
            // does network I/O, so it runs off the listener thread.
            scope.launch(Dispatchers.IO) { runCatching { WebPushSender.sendToAll(this@LinkService, item) } }
            return
        }
        send(msg("notif", "item" to item, "fresh" to fresh))
    }
    fun onNotificationRemoved(key: String) = send(msg("notif_rm", "key" to key))
    fun onMedia(state: JSONObject?) = send(msg("media", "state" to state))
    fun onSms(address: String, body: String) = scope.launch {
        delay(1200)
        send(msg("sms_in", "address" to address, "body" to body, "name" to features.contactName(address), "threadId" to features.threadIdFor(address)))
    }
    fun onCallState(state: String, number: String?) = send(msg("call_state", "state" to state, "number" to number, "name" to number?.let { features.contactName(it) }))

    // ---------------- Files ----------------
    private fun updateTransfer(t: Transfer) {
        if (t.incoming) incomingMeta[t.id] = t
        _transfers.value = (listOf(t) + _transfers.value.filter { it.id != t.id }).take(20)
    }

    private suspend fun startIncoming(m: JSONObject) = withContext(Dispatchers.IO) {
        val id = m.optString("id"); val name = m.optString("name", "file")
        val cv = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, m.optString("mime", "application/octet-stream"))
            put(MediaStore.Downloads.RELATIVE_PATH, "Download/Tsunagu")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv) ?: return@withContext
        val out = contentResolver.openOutputStream(uri) ?: return@withContext
        incoming[id] = uri to out.buffered(256 * 1024)
        updateTransfer(Transfer(id, name, m.optLong("size"), 0, true, "active"))
    }

    private suspend fun finishIncoming(id: String) = withContext(Dispatchers.IO) {
        val (uri, out) = incoming.remove(id) ?: return@withContext
        runCatching { out.flush(); out.close() }
        val t = incomingMeta.remove(id)
        // If fewer bytes arrived than the sender declared, the file would not open:
        // drop the partial entry instead of publishing a corrupt download.
        if (t != null && t.size > 0 && t.done != t.size) {
            runCatching { contentResolver.delete(uri, null, null) }
            updateTransfer(t.copy(state = "error"))
            toast("ファイルが不完全なため保存しませんでした: ${t.name}")
            return@withContext
        }
        contentResolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        t?.let { updateTransfer(it.copy(done = it.size, state = "done")) }
        val open = Intent(Intent.ACTION_VIEW).setDataAndType(uri, contentResolver.getType(uri)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(this@LinkService, id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE)
        getSystemService(NotificationManager::class.java).notify(id.hashCode(), Notification.Builder(this@LinkService, App.CH_EVENT)
            .setSmallIcon(R.drawable.ic_stat).setContentTitle("PC からファイルを受信しました").setContentText(t?.name ?: "")
            .setContentIntent(pi).setAutoCancel(true).build())
        toast("スマホに保存しました: ${t?.name ?: ""}")
    }

    suspend fun sendUri(uri: Uri) = withContext(Dispatchers.IO) {
        if (!connected()) return@withContext
        var name = "file"; var size = 0L
        runCatching {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) { name = c.getString(0) ?: name; size = c.getLong(1) }
            }
        }
        val mime = contentResolver.getType(uri) ?: "application/octet-stream"
        sendStream(name, size, mime) { contentResolver.openInputStream(uri) }
    }

    /** Explorer download: stream a storage file to the PC (same chunk protocol). */
    suspend fun sendFile(f: java.io.File) = withContext(Dispatchers.IO) {
        if (!connected()) return@withContext
        sendStream(f.name, f.length(), Explorer.mimeOf(f)) { java.io.FileInputStream(f) }
    }

    private suspend fun sendStream(name: String, size: Long, mime: String, open: () -> java.io.InputStream?) {
        val id = java.util.UUID.randomUUID().toString().take(12)
        var t = Transfer(id, name, size, 0, false, "active")
        updateTransfer(t)
        if (!sendAwait(msg("file_start", "id" to id, "name" to name, "size" to size, "mime" to mime))) { updateTransfer(t.copy(state = "error")); return }
        val ok = runCatching {
            open()!!.use { input ->
                val buf = ByteArray(48 * 1024); var n: Int; var i = 0
                while (input.read(buf).also { n = it } > 0) {
                    val chunk = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)
                    if (!sendAwait(msg("file_chunk", "id" to id, "d" to chunk))) error("closed")
                    t = t.copy(done = t.done + n)
                    if (i++ % 6 == 0) updateTransfer(t)
                }
            }
            sendAwait(msg("file_end", "id" to id))
        }.getOrDefault(false)
        updateTransfer(t.copy(done = if (ok) size else t.done, state = if (ok) "done" else "error"))
    }

    // ---------------- Vibrate ----------------
    private fun startVibrate() {
        stopVibrate()
        val vm = getSystemService(android.os.VibratorManager::class.java) ?: return
        val v = vm.defaultVibrator
        if (!v.hasVibrator()) { toast("この端末では振動できません"); return }
        vibrator = v
        // Ring-like buzz pattern, looped until the cap below stops it.
        runCatching { v.vibrate(android.os.VibrationEffect.createWaveform(longArrayOf(0, 500, 250, 500, 250, 500, 250, 900), 0)) }
        main.postDelayed(vibStop, 20_000)
        toast("スマホを振動させています")
    }
    private fun stopVibrate() {
        main.removeCallbacks(vibStop)
        runCatching { vibrator?.cancel() }
        vibrator = null
    }

    // ---------------- Explorer ----------------
    private fun sendFsList(rel: String) {
        val l = Explorer.list(rel)
        val o = msg("fs_list", "path" to l.optString("path"), "access" to l.optBoolean("access"),
            "items" to (l.optJSONArray("items") ?: JSONArray()))
        if (l.has("error")) o.put("error", l.optString("error"))
        send(o)
    }
    private fun parentOf(path: String) = path.substringBeforeLast('/', "")

    private suspend fun startFsUpload(m: JSONObject) = withContext(Dispatchers.IO) {
        val id = m.optString("id")
        val dir = m.optString("dir")
        val target = Explorer.uploadTarget(dir, m.optString("name", "file"))
        if (target == null) { toast("アップロード先が不正です"); return@withContext }
        runCatching {
            target.parentFile?.mkdirs()
            fsUploads[id] = FsUp(dir, target, target.outputStream().buffered(256 * 1024), m.optLong("size"))
        }.onFailure { toast("アップロードを開始できませんでした") }
    }

    private suspend fun finishFsUpload(id: String) = withContext(Dispatchers.IO) {
        val up = fsUploads.remove(id) ?: return@withContext
        runCatching { up.out.flush(); up.out.close() }
        // Same rule as regular transfers: never keep a truncated file.
        if (up.size > 0 && up.done != up.size) {
            runCatching { up.file.delete() }
            toast("ファイルが不完全なため保存しませんでした: ${up.file.name}")
        } else {
            toast("スマホに保存しました: ${up.file.name}")
        }
        sendFsList(up.dir)
    }

    // ---------------- Notification ----------------
    private fun fgNotif(text: String): Notification {
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, App.CH_LINK)
            .setSmallIcon(R.drawable.ic_stat).setContentTitle("Tsunagu").setContentText(text)
            .setContentIntent(pi).setOngoing(true).setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE).build()
    }
}
