package com.orokichi.tsunagu

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.util.Base64
import java.io.ByteArrayOutputStream

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_LINK, "接続の維持", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
        nm.createNotificationChannel(NotificationChannel(CH_EVENT, "PC からの操作", NotificationManager.IMPORTANCE_HIGH))
    }

    companion object {
        const val CH_LINK = "link"
        const val CH_EVENT = "event"
    }
}

object Prefs {
    private fun p(c: Context) = c.getSharedPreferences("tsunagu", Context.MODE_PRIVATE)
    fun code(c: Context): String? = p(c).getString("code", null)
    fun token(c: Context): String = p(c).getString("token", "") ?: ""
    fun pcName(c: Context): String = p(c).getString("pc", "PC") ?: "PC"
    fun pair(c: Context, code: String, token: String) = p(c).edit().putString("code", code.uppercase()).putString("token", token).apply()
    fun setToken(c: Context, token: String, pc: String) = p(c).edit().putString("token", token).putString("pc", pc).apply()
    fun unpair(c: Context) {
        p(c).edit().clear().apply()
        // Web Push subscriptions belong to the pairing; drop them too.
        runCatching { WebPushStore.clearAll(c) }
    }
    fun paired(c: Context) = code(c) != null
}

/**
 * Local log of messages sent from the PC through this app.
 *
 * Android only lets the *default* SMS app write to the SMS provider, and
 * SmsManager sends without recording — so without this log, messages sent
 * from the PC would never appear in any history. Features merges these
 * entries into threads()/sms() (deduped against the provider when a copy
 * exists there, e.g. when the provider insert in sendSms succeeded).
 */
object SentLog {
    data class Entry(val address: String, val body: String, val time: Long)

    private fun p(c: Context) = c.getSharedPreferences("tsunagu_sent", Context.MODE_PRIVATE)

    fun add(c: Context, address: String, body: String) {
        val arr = raw(c)
        arr.put(org.json.JSONObject().put("a", address).put("b", body).put("t", System.currentTimeMillis()))
        while (arr.length() > 300) arr.remove(0)
        p(c).edit().putString("log", arr.toString()).apply()
    }

    fun all(c: Context): List<Entry> {
        val arr = raw(c)
        val out = ArrayList<Entry>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            out.add(Entry(o.optString("a"), o.optString("b"), o.optLong("t")))
        }
        return out
    }

    private fun raw(c: Context): org.json.JSONArray =
        runCatching { org.json.JSONArray(p(c).getString("log", "[]")) }.getOrDefault(org.json.JSONArray())

    /** Loose phone-number comparison: digits only, suffix match for local vs +81 forms. */
    fun sameNumber(a: String, b: String): Boolean {
        val da = a.filter { it.isDigit() }; val db = b.filter { it.isDigit() }
        if (da.isEmpty() || db.isEmpty()) return a == b
        if (da == db) return true
        val (long, short) = if (da.length >= db.length) da to db else db to da
        return short.length >= 10 && long.endsWith(short)
    }
}

object Img {
    fun toB64(bmp: Bitmap, png: Boolean = false, q: Int = 78): String {
        val out = ByteArrayOutputStream()
        bmp.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, q, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
    fun drawable(d: Drawable, size: Int): Bitmap {
        if (d is BitmapDrawable && d.bitmap != null) return Bitmap.createScaledBitmap(d.bitmap, size, size, true)
        val b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(b); d.setBounds(0, 0, size, size); d.draw(c); return b
    }
    fun scale(b: Bitmap, max: Int): Bitmap {
        val s = max.toFloat() / maxOf(b.width, b.height)
        return if (s >= 1f) b else Bitmap.createScaledBitmap(b, (b.width * s).toInt().coerceAtLeast(1), (b.height * s).toInt().coerceAtLeast(1), true)
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Prefs.paired(context)) LinkService.start(context)
    }
}
