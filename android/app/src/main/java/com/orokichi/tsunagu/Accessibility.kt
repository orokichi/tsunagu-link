package com.orokichi.tsunagu

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * ユーザー補助（リモート操作） — the phone half of 「スマホ操作」.
 *
 * A normal, non-root app cannot become a USB HID device, so the PC's mouse and
 * keyboard arrive here as AccessibilityService work, which is what Android
 * actually allows:
 *  · pointer → `dispatchGesture` with a `GestureDescription`: a tap (one short
 *    stroke), a long press (one stroke above the long-press timeout), a swipe or
 *    drag (one continuous stroke from down to up, so dragging inside an app
 *    works), and scroll (a short vertical/horizontal fling);
 *  · text → `ACTION_SET_TEXT` / `ACTION_SET_SELECTION` on the focused editable
 *    node, inserting at the caret, plus `ACTION_IME_ENTER` for Enter;
 *  · keys → global actions (戻る / ホーム / 履歴 / 通知 / クイック設定 / 画面ロック)
 *    and node focus movement for Tab / arrows;
 *  · a small `TYPE_ACCESSIBILITY_OVERLAY` ring shows where the PC's pointer is
 *    hovering, so the person holding the phone can see the remote cursor.
 *
 * Everything is best-effort by Android's own rules: a screen that does not expose
 * its nodes (a game, a secure window) can be tapped but not read, and typing only
 * lands in a field that has input focus.
 */
class QuickLinkAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile var instance: QuickLinkAccessibilityService? = null

        /** Is this app's accessibility service switched on in system settings? */
        fun enabled(c: Context): Boolean {
            val want = QuickLinkAccessibilityService::class.java.name
            val on = Settings.Secure.getString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return on.split(':').any { raw ->
                val cn = ComponentName.unflattenFromString(raw.trim()) ?: return@any false
                cn.packageName == c.packageName && (cn.className == want || want.endsWith(cn.className))
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var cursor: View? = null
    private var cursorParams: WindowManager.LayoutParams? = null
    private val hideCursor = Runnable { removeCursor() }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        LinkService.instance?.sendRemoteState()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* the live tree is read on demand */ }

    override fun onInterrupt() {}

    override fun onDestroy() {
        instance = null
        removeCursor()
        LinkService.instance?.sendRemoteState()
        super.onDestroy()
    }

    /* ---------------- screen geometry ---------------- */
    private fun screen(): Pair<Int, Int> = try {
        val b = getSystemService(WindowManager::class.java).currentWindowMetrics.bounds
        b.width() to b.height()
    } catch (e: Exception) {
        val dm = resources.displayMetrics
        dm.widthPixels to dm.heightPixels
    }

    /* ---------------- pointer ---------------- */
    private fun dispatch(stroke: GestureDescription.StrokeDescription) {
        val g = GestureDescription.Builder().addStroke(stroke).build()
        main.post { runCatching { dispatchGesture(g, null, null) } }
    }

    private fun at(path: Path, duration: Long): GestureDescription.StrokeDescription =
        GestureDescription.StrokeDescription(path, 0, duration.coerceIn(20, 3000))

    /** A tap: one zero-length stroke at the point, a few frames long. */
    fun tap(nx: Float, ny: Float) {
        val (w, h) = screen()
        val p = Path().apply { moveTo(nx.coerceIn(0f, 1f) * w, ny.coerceIn(0f, 1f) * h) }
        dispatch(at(p, 60))
        showCursor(nx, ny, 700)
    }

    fun longPress(nx: Float, ny: Float) {
        val (w, h) = screen()
        val p = Path().apply { moveTo(nx.coerceIn(0f, 1f) * w, ny.coerceIn(0f, 1f) * h) }
        val ms = android.view.ViewConfiguration.getLongPressTimeout().toLong() + 350
        dispatch(at(p, ms))
        showCursor(nx, ny, ms + 200)
    }

    fun swipe(nx1: Float, ny1: Float, nx2: Float, ny2: Float, ms: Long) {
        val (w, h) = screen()
        val p = Path().apply {
            moveTo(nx1.coerceIn(0f, 1f) * w, ny1.coerceIn(0f, 1f) * h)
            lineTo(nx2.coerceIn(0f, 1f) * w, ny2.coerceIn(0f, 1f) * h)
        }
        dispatch(at(p, ms))
        showCursor(nx2, ny2, 700)
    }

    /** Wheel: a short fling in the asked direction, from around the pointer. */
    fun scroll(dir: String, nx: Float, ny: Float) {
        val (w, h) = screen()
        val x = nx.coerceIn(0.1f, 0.9f) * w
        val y = ny.coerceIn(0.1f, 0.9f) * h
        val dx = if (dir == "right") -0.22f * w else if (dir == "left") 0.22f * w else 0f
        val dy = if (dir == "down") -0.22f * h else if (dir == "up") 0.22f * h else 0f
        val p = Path().apply { moveTo(x, y); lineTo(x + dx, y + dy) }
        dispatch(at(p, 240))
    }

    /* ---------------- text ---------------- */
    private fun focusedInput(): AccessibilityNodeInfo? = runCatching {
        rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
    }.getOrNull()

    private fun setText(node: AccessibilityNodeInfo, text: String, caret: Int) {
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return
        runCatching {
            val sel = Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, caret.coerceIn(0, text.length))
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, caret.coerceIn(0, text.length))
            }
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
        }
    }

    /** Insert at the caret (the field's selection), the way typing does. */
    fun typeText(text: String) {
        if (text.isEmpty()) return
        main.post {
            val node = focusedInput() ?: return@post
            if (!node.isEditable) return@post
            val cur = node.text?.toString() ?: ""
            var s = node.textSelectionStart
            var e = node.textSelectionEnd
            if (s < 0 || s > cur.length) s = cur.length
            if (e < 0 || e > cur.length) e = cur.length
            val lo = minOf(s, e); val hi = maxOf(s, e)
            val next = cur.substring(0, lo) + text + cur.substring(hi)
            setText(node, next, lo + text.length)
        }
    }

    fun backspace() = main.post {
        val node = focusedInput() ?: return@post
        if (!node.isEditable) return@post
        val cur = node.text?.toString() ?: return@post
        var s = node.textSelectionStart
        var e = node.textSelectionEnd
        if (s < 0 || s > cur.length) s = cur.length
        if (e < 0 || e > cur.length) e = cur.length
        val lo = minOf(s, e); val hi = maxOf(s, e)
        if (lo == hi) {
            if (lo == 0) return@post
            setText(node, cur.substring(0, lo - 1) + cur.substring(lo), lo - 1)
        } else setText(node, cur.substring(0, lo) + cur.substring(hi), lo)
    }

    fun selectAll() = main.post {
        val node = focusedInput() ?: return@post
        val len = node.text?.length ?: return@post
        val sel = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, len)
        }
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
    }

    /** Enter: the focused field's own IME action (send / search / done). */
    fun enter() = main.post {
        val node = focusedInput() ?: return@post
        // ACTION_IME_ENTER is an AccessibilityAction (API 30+), not an int constant.
        node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
    }

    /* ---------------- keys ---------------- */
    private fun scrollPage(forward: Boolean): Boolean {
        var n: AccessibilityNodeInfo? = focusedInput() ?: rootInActiveWindow
        var hop = 0
        while (n != null && hop++ < 12) {
            if (n.isScrollable) {
                val a = if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                if (n.performAction(a)) return true
            }
            n = n.parent
        }
        return false
    }

    private fun moveFocus(forward: Boolean): Boolean {
        val root = rootInActiveWindow ?: return false
        val cur = focusedInput() ?: root
        val dir = if (forward) View.FOCUS_FORWARD else View.FOCUS_BACKWARD
        val next = cur.focusSearch(dir) ?: root.focusSearch(dir) ?: return false
        next.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        next.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
        return true
    }

    private fun wake() {
        runCatching {
            val pm = getSystemService(PowerManager::class.java)
            @Suppress("DEPRECATION")
            val lock = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "quicklink:screen")
            lock.acquire(3000)
        }
    }

    /** One keyboard action from the PC. Returns false for an unknown name. */
    fun key(name: String): Boolean = when (name) {
        "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
        "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
        "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
        "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
        "quick_settings" -> performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
        "lock" -> performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
        "screen_on" -> { wake(); true }
        "enter" -> { enter(); true }
        "backspace", "delete" -> { backspace(); true }
        "tab" -> moveFocus(true)
        "select_all" -> { selectAll(); true }
        "up" -> scrollPage(false)
        "down" -> scrollPage(true)
        "left" -> moveFocus(false)
        "right" -> moveFocus(true)
        else -> false
    }

    /* ---------------- remote cursor ---------------- */
    fun hover(nx: Float, ny: Float) = showCursor(nx, ny, 2200)

    private fun showCursor(nx: Float, ny: Float, keepMs: Long) {
        val (w, h) = screen()
        val x = (nx.coerceIn(0f, 1f) * w).toInt()
        val y = (ny.coerceIn(0f, 1f) * h).toInt()
        main.post {
            val wm = getSystemService(WindowManager::class.java)
            val density = resources.displayMetrics.density
            val size = (22 * density).toInt()
            if (cursor == null) {
                val v = View(this)
                v.background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(0x33000000)
                    setStroke((2 * density).toInt(), 0xFFFFFFFF.toInt())
                }
                val lp = WindowManager.LayoutParams(
                    size, size,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT,
                ).apply { gravity = Gravity.TOP or Gravity.START }
                if (runCatching { wm.addView(v, lp) }.isSuccess) {
                    cursor = v
                    cursorParams = lp
                }
            }
            val lp = cursorParams ?: return@post
            lp.x = x - size / 2
            lp.y = y - size / 2
            runCatching { cursor?.let { wm.updateViewLayout(it, lp) } }
            main.removeCallbacks(hideCursor)
            main.postDelayed(hideCursor, keepMs)
        }
    }

    private fun removeCursor() {
        main.post {
            cursor?.let { v -> runCatching { getSystemService(WindowManager::class.java).removeView(v) } }
            cursor = null
            cursorParams = null
        }
    }
}
