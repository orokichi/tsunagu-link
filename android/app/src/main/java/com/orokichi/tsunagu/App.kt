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
    fun unpair(c: Context) = p(c).edit().clear().apply()
    fun paired(c: Context) = code(c) != null
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
