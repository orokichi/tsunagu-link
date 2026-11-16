package com.orokichi.tsunagu

import android.app.Activity
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.math.max

/**
 * 画面ミラーリング — the phone's screen, live, to the PC.
 *
 * `MediaProjection` captures the display; the frames are scaled so the long side
 * is ≈720 px, encoded as JPEG (quality 55) and sent only when the picture actually
 * changed, at most ~12 fps. Nothing is recorded or stored: a frame exists only
 * between the capture and the data channel.
 *
 * Android requires the projection permission to be granted from an Activity, so
 * MirrorActivity raises the system dialog and hands the result here; this service
 * then runs in the foreground with the `mediaProjection` type for as long as the
 * mirror is on.
 */
class MirrorService : Service() {

    companion object {
        /** Written by the service, read by the link and the app's UI. */
        @Volatile var running = false
        /** off / requesting / live / denied / error */
        @Volatile var state = "off"
        /** The phone's real screen size, what the PC's touch coordinates map to. */
        @Volatile var screenW = 0
        @Volatile var screenH = 0
        @Volatile var fps = 0

        private const val ID = 2
        private const val EXTRA_CODE = "resultCode"
        private const val EXTRA_DATA = "data"

        fun start(c: Context, resultCode: Int, data: Intent) {
            val i = Intent(c, MirrorService::class.java)
                .putExtra(EXTRA_CODE, resultCode)
                .putExtra(EXTRA_DATA, data)
            runCatching { c.startForegroundService(i) }
        }

        fun stop(c: Context) { runCatching { c.stopService(Intent(c, MirrorService::class.java)) } }

        /** Ask the user for the projection permission (always a fresh system dialog). */
        fun request(c: Context) {
            if (running) { LinkService.instance?.sendRemoteState(); return }
            state = "requesting"
            val i = Intent(c, MirrorActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
            // Starting an Activity from the background is only allowed with the
            // draw-over-other-apps grant; without it, a tappable notification is
            // the way to bring the permission dialog up.
            if (Settings.canDrawOverlays(c) && runCatching { c.startActivity(i); true }.getOrDefault(false)) return
            val pi = PendingIntent.getActivity(c, 92, i, PendingIntent.FLAG_IMMUTABLE)
            runCatching {
                c.getSystemService(NotificationManager::class.java).notify(92,
                    Notification.Builder(c, App.CH_EVENT)
                        .setSmallIcon(R.drawable.ic_stat)
                        .setContentTitle("画面の共有")
                        .setContentText("タップして、スマホの画面を PC に表示するのを許可してください")
                        .setContentIntent(pi).setAutoCancel(true).build())
            }
        }

        internal fun notifyState(st: String, reason: String = "", w: Int = screenW, h: Int = screenH, f: Int = fps) {
            val l = LinkService.instance ?: return
            l.send(l.msg("mirror_state", "state" to st, "w" to w, "h" to h, "fps" to f, "reason" to reason))
        }
    }

    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var lastSent = 0L
    private var lastHash = 0
    private var lastSize = 0
    private var frames = 0
    private var secondStart = 0L
    private var captureW = 0
    private var captureH = 0
    private var closed = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null || !intent.hasExtra(EXTRA_CODE)) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(ID, notif(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        val code = intent.getIntExtra(EXTRA_CODE, 0)
        @Suppress("DEPRECATION")
        val data: Intent? = intent.getParcelableExtra(EXTRA_DATA)
        val manager = getSystemService(MediaProjectionManager::class.java)
        val p = runCatching { if (data != null) manager.getMediaProjection(code, data) else null }.getOrNull()
        if (p == null) {
            state = "error"
            notifyState("error", "projection")
            stopSelf()
            return START_NOT_STICKY
        }
        projection = p
        p.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { finish("off") }
        }, Handler(Looper.getMainLooper()))

        val dm = resources.displayMetrics
        val sw = dm.widthPixels
        val sh = dm.heightPixels
        screenW = sw
        screenH = sh
        // Long side 720 px, even numbers (JPEG-friendly), never smaller than 2 px.
        val scale = 720f / max(sw, sh).coerceAtLeast(1).toFloat()
        captureW = max(2, ((sw * scale).toInt() / 2) * 2)
        captureH = max(2, ((sh * scale).toInt() / 2) * 2)

        val ht = HandlerThread("quicklink-mirror").also { it.start() }
        thread = ht
        val r = ImageReader.newInstance(captureW, captureH, PixelFormat.RGBA_8888, 2)
        reader = r
        r.setOnImageAvailableListener({ source -> onImage(source) }, Handler(ht.looper))
        display = p.createVirtualDisplay(
            "quicklink-mirror", captureW, captureH, dm.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, null,
        )
        running = true
        state = "live"
        secondStart = System.currentTimeMillis()
        notifyState("live")
        return START_NOT_STICKY
    }

    private fun onImage(source: ImageReader) {
        val image: Image = runCatching { source.acquireLatestImage() }.getOrNull() ?: return
        var full: Bitmap? = null
        var cropped: Bitmap? = null
        try {
            if (closed) return
            val now = System.currentTimeMillis()
            if (now - lastSent < 70) return // ~14 fps ceiling; the rest of the time is spend on encode/transport
            val plane = image.planes[0]
            val w = captureW
            val h = captureH
            val rowStride = plane.rowStride
            val pixelStride = plane.pixelStride
            val pad = rowStride - pixelStride * w
            if (pad < 0) return
            full = Bitmap.createBitmap(w + pad / pixelStride, h, Bitmap.Config.ARGB_8888)
            full.copyPixelsFromBuffer(plane.buffer)
            cropped = if (pad > 0) Bitmap.createBitmap(full, 0, 0, w, h) else full
            val out = ByteArrayOutputStream(64 * 1024)
            cropped.compress(Bitmap.CompressFormat.JPEG, 55, out)
            val bytes = out.toByteArray()
            frames++
            if (now - secondStart >= 1000) {
                fps = frames
                frames = 0
                secondStart = now
            }
            // Skip a frame that is byte-identical to the last one sent (a static
            // screen would otherwise cost bandwidth for nothing).
            val hash = bytes.contentHashCode()
            if (hash == lastHash && bytes.size == lastSize) return
            lastHash = hash
            lastSize = bytes.size
            lastSent = now
            val l = LinkService.instance ?: return
            if (!l.connected()) return
            val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            l.send(l.msg("mirror_frame", "d" to b64, "w" to screenW, "h" to screenH, "ts" to now))
        } catch (e: Exception) {
            android.util.Log.w("QuickLink", "mirror frame", e)
        } finally {
            runCatching { image.close() }
            if (cropped != null && cropped !== full) runCatching { cropped.recycle() }
            runCatching { full?.recycle() }
        }
    }

    override fun onDestroy() {
        finish("off")
        super.onDestroy()
    }

    private fun finish(st: String) {
        if (closed) return
        closed = true
        running = false
        state = st
        fps = 0
        runCatching { reader?.setOnImageAvailableListener(null, null) }
        runCatching { reader?.close() }
        reader = null
        runCatching { display?.release() }
        display = null
        runCatching { projection?.stop() }
        projection = null
        thread?.quitSafely()
        thread = null
        notifyState(st)
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
    }

    private fun notif(): Notification {
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, App.CH_LINK)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Quick Link")
            .setContentText("スマートフォンの画面を PC に表示中")
            .setContentIntent(pi).setOngoing(true)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}

/**
 * Raises the system "start capturing?" dialog. Invisible, finishes immediately
 * after the answer is handed to MirrorService.
 */
class MirrorActivity : Activity() {
    companion object { private const val REQ = 4711 }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val manager = getSystemService(MediaProjectionManager::class.java)
        val ok = runCatching { startActivityForResult(manager.createScreenCaptureIntent(), REQ); true }.getOrDefault(false)
        if (!ok) finish()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ) {
            if (resultCode == RESULT_OK && data != null) {
                MirrorService.start(this, resultCode, data)
            } else {
                MirrorService.notifyState("denied")
                LinkService.instance?.toast("画面の共有が許可されませんでした")
            }
        }
        finish()
    }
}
