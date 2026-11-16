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
        /** The connected PC as it describes itself (name, browser, OS, battery, online…). */
        private val _pc = MutableStateFlow<JSONObject?>(null)
        val pc: StateFlow<JSONObject?> = _pc
        /** True while this phone is ringing the PC (「PC を鳴らす」). */
        private val _pcRinging = MutableStateFlow(false)
        val pcRinging: StateFlow<Boolean> = _pcRinging
        @Volatile var lastClip: String = ""
        /** True while MainActivity is in front: Android 14+ only lets an app start a
         *  location foreground service with 使用中のみ permission from the foreground. */
        @Volatile var appVisible: Boolean = false
        /** Messages per page; older pages are fetched as the PC scrolls back. */
        const val SMS_PAGE = 60

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
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default + kotlinx.coroutines.CoroutineExceptionHandler { _, e -> android.util.Log.w("QuickLink", "handler", e) })
    private var web: WebView? = null
    private var ready = false
    private lateinit var features: Features
    private val incoming = HashMap<String, Pair<Uri, OutputStream>>()
    private val incomingMeta = HashMap<String, Transfer>()
    private var infoJob: Job? = null
    private val fileQueue = kotlinx.coroutines.channels.Channel<Pair<JSONObject, String>>(kotlinx.coroutines.channels.Channel.UNLIMITED)
    // ---- LAN direct connection ----
    private var lanServer: LanServer? = null
    // ---- USB cable (ADB over WebUSB): no network at all ----
    private var usbServer: UsbServer? = null
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
    // Battery saver on/off is not carried by ACTION_BATTERY_CHANGED: its own
    // broadcast keeps the PC's battery-saver chip in step the moment it changes.
    private val powerSave = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) { if (connected()) sendInfo() }
    }

    // ---- Quick settings (rotation / ringer / DND / media volume) → PC ----
    private var sysPushJob: Job? = null
    private val sysReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) = scheduleSysPush()
    }
    private val rotationObserver = object : android.database.ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) = scheduleSysPush()
    }
    fun scheduleSysPush() {
        if (!connected()) return
        sysPushJob?.cancel()
        sysPushJob = scope.launch { delay(250); sendSys() }
    }
    fun sendSys() { if (connected()) send(msg("sys", "sys" to SysControls.state(this))) }

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
            sendThreads()
            watchedThread?.let { sendSmsPage(it) }
        }
    }

    fun connected() = _status.value == "connected"
    fun rewatchMedia() = main.post { features.unwatchMedia(); features.watchMedia() }

    // ---- Liveness ----
    /** Last moment anything arrived from the PC. The PC pings every few seconds;
     *  a WebRTC data channel can stay "open" long after the other side is gone
     *  (Wi-Fi roamed, the Chromebook slept), which used to leave the app claiming
     *  「接続中」 with nothing moving. */
    @Volatile private var lastRxAt = System.currentTimeMillis()

    private fun startWatchdog() {
        scope.launch {
            while (isActive) {
                delay(4000)
                if (!connected() || activeVia == "usb") continue
                if (System.currentTimeMillis() - lastRxAt < 16_000) continue
                lastRxAt = System.currentTimeMillis()
                main.post {
                    // Drop the live transport and redial the cloud; a fresh LAN
                    // offer from the PC will take over again if it is reachable.
                    infoJob?.cancel()
                    _pc.value = null; _pcRinging.value = false
                    activeVia = null; _via.value = ""
                    setStatus("connecting")
                    js("B.setActive('cloud')")
                    js("B.kick()")
                    refreshFg()
                }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        features = Features(this)
        startFg()
        createWeb()
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(net)
        registerReceiver(battery, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        runCatching {
            registerReceiver(powerSave, IntentFilter(android.os.PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
        }
        runCatching {
            val f = IntentFilter().apply {
                addAction("android.media.VOLUME_CHANGED_ACTION")
                addAction(android.media.AudioManager.RINGER_MODE_CHANGED_ACTION)
                addAction(NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED)
                addAction(NotificationManager.ACTION_NOTIFICATION_POLICY_ACCESS_GRANTED_CHANGED)
            }
            androidx.core.content.ContextCompat.registerReceiver(this, sysReceiver, f, androidx.core.content.ContextCompat.RECEIVER_EXPORTED)
            contentResolver.registerContentObserver(android.provider.Settings.System.getUriFor(android.provider.Settings.System.ACCELEROMETER_ROTATION), false, rotationObserver)
        }
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
        startWatchdog()
        // USB cable endpoint: the PC's browser is the ADB host, so it reaches
        // this socket with Wi-Fi, mobile data and the internet all switched off.
        usbServer = runCatching {
            UsbServer(
                authHashes = {
                    val out = HashSet<String>()
                    val token = Prefs.token(this)
                    if (token.isNotEmpty()) out.add(sha256Hex(token))
                    // The pairing code too, so コードを作り直したあとでも繋ぎ直せる.
                    Prefs.code(this)?.let { out.add(sha256Hex(it)) }
                    out
                },
                hello = { features.hello(Prefs.token(this)) },
                onMessage = { m ->
                    val t = m.optString("t")
                    if (t.startsWith("file_") || t.startsWith("fs_put")) fileQueue.trySend(m to "usb")
                    else scope.launch { handle(m, "usb") }
                },
                onClosed = { main.post { usbClosed() } },
            ).also { it.start() }
        }.getOrNull()
    }

    /** The cable session ended: hand the connection back to the network transports. */
    private fun usbClosed() {
        if (activeVia != "usb") return
        activeVia = null; _via.value = ""
        infoJob?.cancel()
        _pc.value = null; _pcRinging.value = false
        setStatus("connecting")
        js("B.setActive('cloud')")
        refreshFg()
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
        runCatching { unregisterReceiver(powerSave) }
        runCatching { unregisterReceiver(sysReceiver) }
        runCatching { contentResolver.unregisterContentObserver(rotationObserver) }
        _pc.value = null; _pcRinging.value = false
        runCatching { contentResolver.unregisterContentObserver(smsObserver) }
        features.unwatchMedia()
        usbServer?.stop(); usbServer = null
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
        @JavascriptInterface fun onStatus(s: String) { main.post { if (activeVia == null || activeVia == "cloud") setStatus(s) } }
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
                    _pc.value = null; _pcRinging.value = false
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
            s == "disconnected" -> { infoJob?.cancel(); _pc.value = null; _pcRinging.value = false; "connecting" }
            else -> if (_status.value == "connected" && s.startsWith("error")) "connecting" else "connecting"
        }
        if (v == _status.value) return
        _status.value = v
        refreshFg()
    }

    private fun refreshFg() {
        getSystemService(NotificationManager::class.java).notify(1, fgNotif(fgText()))
    }

    private fun fgText(): String = if (_status.value == "connected") {
        val route = when (activeVia) {
            "lan" -> "（同じネットワークで直接接続）"
            "usb" -> "（USB ケーブルで接続）"
            "cloud" -> "（クラウド経由）"
            else -> ""
        }
        "${Prefs.pcName(this)} と接続中$route"
    } else "PC を探しています…"

    // ---------------- 位置情報のフォアグラウンドサービス ----------------
    @Volatile private var fgLocation = false

    /** Foreground service types for this run. A location service needs the location
     *  permission, and with only 使用中のみ it may not be started from the background,
     *  so the type is added only when that is allowed (see promoteLocation). */
    private fun fgTypes(): Int {
        val base = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        if (!Features.locGranted(this)) return base
        if (!Features.locAlways(this) && !appVisible) return base
        return base or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
    }

    private fun startFg() {
        val t = fgTypes()
        try {
            startForeground(1, fgNotif(fgText()), t)
            fgLocation = (t and ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) != 0
        } catch (e: Exception) {
            // Not allowed right now (missing permission, or started from the
            // background): keep the link itself alive as specialUse.
            fgLocation = false
            runCatching { startForeground(1, fgNotif(fgText()), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) }
        }
    }

    /**
     * Called when the app comes to the front (or a location permission was just
     * granted). Upgrades the running service to a location foreground service so
     * 「探す」 keeps working while the app is in the background with only 使用中のみ
     * granted — the plain link service counts as background for the location APIs.
     */
    fun promoteLocation() {
        main.post {
            if (_status.value == "idle" || fgLocation) return@post
            if (!Features.locGranted(this)) return@post
            val t = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            runCatching {
                startForeground(1, fgNotif(fgText()), t)
                fgLocation = true
            }
        }
    }

    /** Answers 「探す」 (also used right after a permission was granted). */
    fun sendLocation() {
        scope.launch {
            val o = withContext(Dispatchers.IO) {
                runCatching { features.location(fgLocation) }.getOrElse { msg("location", "error" to "unavailable") }
            }
            val out = msg("location")
            o.keys().forEach { k -> out.put(k, o.get(k)) }
            send(out)
        }
    }

    /** Brings the app to the front from the background (to grant a permission or
     *  take a fix with 使用中のみ). Only apps that may draw over other apps can start
     *  activities freely, so a tappable notification is the fallback. */
    private fun launchApp(loc: String, text: String) {
        val i = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_LOC, loc)
        if (android.provider.Settings.canDrawOverlays(this) && runCatching { startActivity(i); true }.getOrDefault(false)) {
            toast("スマホのアプリで位置情報を確認しています")
            return
        }
        val pi = PendingIntent.getActivity(this, 91, i, PendingIntent.FLAG_IMMUTABLE)
        getSystemService(NotificationManager::class.java).notify(91, Notification.Builder(this, App.CH_EVENT)
            .setSmallIcon(R.drawable.ic_stat).setContentTitle("Quick Link").setContentText(text)
            .setContentIntent(pi).setAutoCancel(true).build())
        toast("スマホの通知をタップしてください（$text）")
    }

    private fun js(code: String, cb: ((String) -> Unit)? = null) {
        main.post { if (ready) web?.evaluateJavascript(code) { r -> cb?.invoke(r ?: "") } else cb?.invoke("-1") }
    }

    fun send(o: JSONObject) {
        // While the cable is the live transport everything goes straight to the
        // USB socket: the WebView's PeerJS/LAN links are idle (and may well be
        // offline). See usbClosed() for the way back.
        if (activeVia == "usb") { usbServer?.send(o.toString()); return }
        if (connected() || o.optString("t") == "hello") js("B.send(${JSONObject.quote(o.toString())})")
    }

    /** Sends and waits while the data channel buffer is large (backpressure for files).
     *  Bounded in time: a link that stops draining must never hang a transfer
     *  (or the queue behind it) forever. */
    private suspend fun sendAwait(o: JSONObject): Boolean {
        val deadline = System.currentTimeMillis() + 60_000
        if (activeVia == "usb") {
            // The USB writer thread drains its own queue; wait on that depth.
            var buf = (usbServer?.send(o.toString()) ?: -1).toLong()
            if (buf < 0) return false
            while (buf > 3_000_000L) {
                if (System.currentTimeMillis() > deadline) return false
                delay(40)
                buf = usbServer?.buffered() ?: -1L
                if (buf < 0) return false
            }
            return true
        }
        val r = suspendCancellableCoroutine<String> { c -> js("B.send(${JSONObject.quote(o.toString())})") { c.resume(it) } }
        var buf = r.toLongOrNull() ?: -1
        if (buf < 0) return false
        while (buf > 3_000_000) {
            if (System.currentTimeMillis() > deadline) return false
            if (!connected()) return false
            delay(40)
            buf = suspendCancellableCoroutine<String> { c -> js("B.buffered()") { c.resume(it) } }.toLongOrNull() ?: -1
            if (buf < 0) return false
        }
        return true
    }

    fun msg(t: String, vararg kv: Pair<String, Any?>) = JSONObject().put("t", t).also { o -> kv.forEach { o.put(it.first, it.second ?: JSONObject.NULL) } }

    // ---------------- Incoming messages ----------------
    private suspend fun handle(m: JSONObject, via: String = "cloud") {
        // Every message (the PC's heartbeat included) proves the link is alive.
        lastRxAt = System.currentTimeMillis()
        when (m.optString("t")) {
            // Heartbeat answer: the PC measures the round trip with this.
            "ping" -> send(msg("pong", "ts" to m.optLong("ts")))
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
                _pc.value = m.optJSONObject("pcInfo")
                activeVia = via; _via.value = via
                js("B.setActive(${JSONObject.quote(via)})")
                withContext(Dispatchers.Main) { setStatus("connected"); refreshFg() }
                sendInfo(); sendNotifs()
                infoJob?.cancel()
                infoJob = scope.launch { while (isActive) { delay(60_000); sendInfo() } }
            }
            "push_subscribe" -> {
                // The PC hands over its browser PushSubscription so the phone
                // can reach it with Web Push while the Quick Link page is closed.
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
                "notifs" -> sendNotifs()
                "media" -> send(msg("media", "state" to features.mediaState()))
                "threads" -> sendThreads()
                "sms" -> {
                    val tid = m.optString("threadId")
                    watchedThread = tid
                    sendSmsPage(tid, m.optLong("before", 0))
                }
                "calls" -> send(msg("calls", "items" to features.calls()))
                "photos" -> {
                    val off = m.optInt("offset", 0)
                    val (items, more) = features.photos(off, 48)
                    send(msg("photos", "items" to items, "offset" to off, "hasMore" to more))
                }
                "location" -> sendLocation()
                "fs" -> sendFsList(m.optString("path"))
                "sys" -> sendSys()
            }
            // ---- quick settings from the PC ----
            "sys_set" -> {
                val err = when (m.optString("key")) {
                    "rotate" -> SysControls.setRotate(this, m.optBoolean("on"))
                    "ringer" -> SysControls.setRinger(this, m.optString("mode"))
                    "dnd" -> SysControls.setDnd(this, m.optBoolean("on"))
                    "vol" -> SysControls.setVolume(this, m.optInt("value"))
                    "vol_step" -> SysControls.stepVolume(this, m.optInt("dir", 1))
                    "mute" -> SysControls.setMute(this, m.optBoolean("on"))
                    else -> null
                }
                if (err != null) send(msg("sys_err", "text" to err, "sys" to SysControls.state(this)))
                else { delay(150); sendSys() }
            }
            "sys_perm" -> withContext(Dispatchers.Main) {
                val intent = when (m.optString("which")) {
                    "write_settings" -> Intent(android.provider.Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:$packageName"))
                    else -> Intent(android.provider.Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
                }
                val ok = runCatching { startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true }.getOrDefault(false)
                toast(if (ok) "スマホで許可してください（許可後、自動で反映されます）" else "設定画面を開けませんでした")
            }
            // ---- the PC describes itself / reports its ring state ----
            "pc_info" -> _pc.value = m.optJSONObject("info")
            "pc_ring_state" -> _pcRinging.value = m.optBoolean("on")
            "mark_read" -> {
                val tid = m.optString("threadId")
                if (tid.isNotEmpty()) {
                    runCatching { features.markRead(tid) }
                    sendThreads()
                    sendSmsPage(tid)
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
            // ---- 探す: the PC cannot grant permissions, only open the app ----
            "loc_perm" -> launchApp(if (m.optString("which") == "always") "always" else "fix",
                if (m.optString("which") == "always") "位置情報を「常に許可」にする" else "位置情報を許可する")
            "loc_now" -> launchApp("fix", "位置を取得しています")
            // 通知へのアクセス (notification listener) can only be switched on by hand.
            "perm_open" -> when (m.optString("which")) {
                "listener" -> {
                    val i = Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (runCatching { startActivity(i); true }.getOrDefault(false)) toast("スマホで Quick Link の「通知へのアクセス」をオンにしてください")
                    else toast("スマホの「設定」→「通知」→「通知へのアクセス」でオンにしてください")
                }
                else -> launchApp("fix", "位置情報を許可する")
            }
            "notif_dismiss" -> {
                val key = m.optString("key")
                val l = NotifListener.instance
                if (l == null || !NotifListener.enabled(this)) {
                    send(msg("notif_dismiss_result", "key" to key, "ok" to false, "reason" to "off"))
                } else {
                    val (ok, reason) = l.dismiss(key)
                    if (!ok) send(msg("notif_dismiss_result", "key" to key, "ok" to false, "reason" to reason))
                    else if (key == "*") send(msg("notif_dismiss_result", "key" to key, "ok" to true, "reason" to ""))
                    else {
                        scope.launch {
                            // Verify: a notification the OS will not let go of (ongoing /
                            // no-clear) is still there a moment after the cancel.
                            delay(600)
                            val left = runCatching { l.isActive(key) }.getOrDefault(false)
                            send(msg("notif_dismiss_result", "key" to key, "ok" to !left,
                                "reason" to if (left) "locked" else ""))
                        }
                    }
                }
            }
            "notif_reply" -> NotifListener.instance?.reply(m.optString("key"), m.optString("text"))?.let { ok -> toast(if (ok) "返信しました" else "返信できませんでした") }
            "notif_action" -> NotifListener.instance?.action(m.optString("key"), m.optInt("index"))
            "media_cmd" -> features.mediaCommand(m.optString("cmd"))
            "sms_send" -> {
                val ok = features.sendSms(m.optString("to"), m.optString("body"))
                toast(if (ok) "SMS を送信しました" else "SMS を送信できませんでした（権限を確認してください）")
                m.optString("threadId").takeIf { it.isNotEmpty() && it != "new" }?.let { watchedThread = it }
                delay(1500)
                sendThreads()
                m.optString("threadId").takeIf { it.isNotEmpty() && it != "new" }?.let { sendSmsPage(it) }
            }
            "dial" -> toast(if (features.dial(m.optString("number"))) "スマホから発信しています" else "発信できませんでした（電話の権限を確認してください）")
            "call_end" -> features.endCall()
            "clip" -> m.optString("text").let { t ->
                lastClip = t
                withContext(Dispatchers.Main) { getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Quick Link", t)) }
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

    // ---------------- Notifications / messages to the PC ----------------
    private suspend fun sendNotifs() {
        val (items, err) = features.notifications()
        send(msg("notifs", "items" to items, "error" to err))
    }

    private suspend fun sendThreads() {
        val (items, err) = runCatching<Pair<JSONArray, String?>> { withContext(Dispatchers.IO) { features.threadsSafe() } }
            .getOrElse { JSONArray() to (it.message ?: "error") }
        send(msg("threads", "items" to items, "error" to err))
    }

    /** Sends one page of a conversation. Always answers — even when the provider
     *  query fails — so the PC never waits for a reply that never comes. */
    private suspend fun sendSmsPage(threadId: String, before: Long = 0) {
        val page = runCatching { withContext(Dispatchers.IO) { features.smsPage(threadId, before, SMS_PAGE) } }
            .getOrElse { SmsPage(JSONArray(), false, it.message ?: "error") }
        send(msg("sms", "threadId" to threadId, "items" to page.items, "hasMore" to page.hasMore,
            "older" to (before > 0), "error" to page.error))
    }

    // ---------------- Phone → PC actions (the PC screen in the app) ----------------
    fun pcOpenUrl(url: String) {
        val u = url.trim().let { if (it.startsWith("http://") || it.startsWith("https://")) it else "https://$it" }
        send(msg("pc_open", "url" to u))
    }
    fun pcText(text: String) { if (text.isNotBlank()) send(msg("pc_text", "text" to text)) }
    fun pcPing(text: String) = send(msg("pc_ping", "text" to text.ifBlank { "スマホから呼び出しがあります" }))
    fun pcRing(on: Boolean) { _pcRinging.value = on; send(msg("pc_ring", "on" to on)) }
    fun pcRefresh() = send(msg("pc_get"))

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
            .setSmallIcon(R.drawable.ic_stat).setContentTitle("Quick Link").setContentText(text)
            .setContentIntent(pi).setOngoing(true).setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE).build()
    }
}
