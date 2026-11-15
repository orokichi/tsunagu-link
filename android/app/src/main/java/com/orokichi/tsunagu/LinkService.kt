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
    private val fileQueue = kotlinx.coroutines.channels.Channel<JSONObject>(kotlinx.coroutines.channels.Channel.UNLIMITED)
    private var ringer: Ringer? = null
    private val net = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { main.post { js("B.kick()") } }
    }
    private val battery = object : android.content.BroadcastReceiver() {
        var last = -1
        override fun onReceive(c: Context, i: Intent) {
            val lv = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            if (lv != last) { last = lv; if (connected()) sendInfo() }
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
        features.watchMedia()
        scope.launch { for (m in fileQueue) runCatching { handle(m) } }
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
        features.unwatchMedia()
        ringer?.stop()
        js("B.stop()")
        web?.destroy(); web = null
        scope.cancel()
        _status.value = "idle"
        super.onDestroy()
    }

    // ---------------- WebView / PeerJS bridge ----------------
    inner class Bridge {
        @JavascriptInterface fun onReady() { main.post { ready = true; boot() } }
        @JavascriptInterface fun onStatus(s: String) { main.post { setStatus(s) } }
        @JavascriptInterface fun onMessage(json: String) {
            val m = runCatching { JSONObject(json) }.getOrNull() ?: return
            if (m.optString("t").startsWith("file_")) fileQueue.trySend(m) else scope.launch { handle(m) }
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
        getSystemService(NotificationManager::class.java).notify(1, fgNotif(if (v == "connected") "${Prefs.pcName(this)} と接続中" else "PC を探しています…"))
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
    private suspend fun handle(m: JSONObject) {
        when (m.optString("t")) {
            "welcome" -> {
                Prefs.setToken(this, m.optString("token"), m.optString("pc", "PC"))
                withContext(Dispatchers.Main) { setStatus("connected") }
                sendInfo(); send(msg("notifs", "items" to features.notifications()))
                infoJob?.cancel()
                infoJob = scope.launch { while (isActive) { delay(60_000); sendInfo() } }
            }
            "get" -> when (m.optString("what")) {
                "info" -> sendInfo()
                "notifs" -> send(msg("notifs", "items" to features.notifications()))
                "media" -> send(msg("media", "state" to features.mediaState()))
                "threads" -> send(msg("threads", "items" to features.threads()))
                "sms" -> m.optString("threadId").let { send(msg("sms", "threadId" to it, "items" to features.sms(it))) }
                "calls" -> send(msg("calls", "items" to features.calls()))
                "photos" -> {
                    val off = m.optInt("offset", 0)
                    val (items, more) = features.photos(off, 48)
                    send(msg("photos", "items" to items, "offset" to off, "hasMore" to more))
                }
            }
            "notif_dismiss" -> NotifListener.instance?.dismiss(m.optString("key"))
            "notif_reply" -> NotifListener.instance?.reply(m.optString("key"), m.optString("text"))?.let { ok -> toast(if (ok) "返信しました" else "返信できませんでした") }
            "notif_action" -> NotifListener.instance?.action(m.optString("key"), m.optInt("index"))
            "media_cmd" -> features.mediaCommand(m.optString("cmd"))
            "sms_send" -> {
                val ok = features.sendSms(m.optString("to"), m.optString("body"))
                toast(if (ok) "SMS を送信しました" else "SMS を送信できませんでした（権限を確認してください）")
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
                if (m.optBoolean("on", true)) { ringer?.stop(); ringer = Ringer(this@LinkService).also { it.start() }; toast("スマホを鳴らしています") } else ringer?.stop()
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

    fun onNotification(item: JSONObject, fresh: Boolean) = send(msg("notif", "item" to item, "fresh" to fresh))
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
        val id = java.util.UUID.randomUUID().toString().take(12)
        var t = Transfer(id, name, size, 0, false, "active")
        updateTransfer(t)
        if (!sendAwait(msg("file_start", "id" to id, "name" to name, "size" to size, "mime" to mime))) { updateTransfer(t.copy(state = "error")); return@withContext }
        val ok = runCatching {
            contentResolver.openInputStream(uri)!!.use { input ->
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

    // ---------------- Notification ----------------
    private fun fgNotif(text: String): Notification {
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, App.CH_LINK)
            .setSmallIcon(R.drawable.ic_stat).setContentTitle("Tsunagu").setContentText(text)
            .setContentIntent(pi).setOngoing(true).setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE).build()
    }
}
