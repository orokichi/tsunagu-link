package com.orokichi.tsunagu

import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Telephony
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.telephony.TelephonyManager
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject

class NotifListener : NotificationListenerService() {
    companion object {
        @Volatile var instance: NotifListener? = null
        fun enabled(c: Context): Boolean {
            val s = android.provider.Settings.Secure.getString(c.contentResolver, "enabled_notification_listeners") ?: return false
            return s.contains(c.packageName)
        }
    }
    private val icons = HashMap<String, String?>()
    private val seen = HashSet<String>()

    override fun onListenerConnected() {
        instance = this
        activeNotifications?.forEach { seen.add(it.key) }
        if (Prefs.paired(this)) runCatching { LinkService.start(this) }
        LinkService.instance?.rewatchMedia()
    }
    override fun onListenerDisconnected() { instance = null }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val j = serialize(sbn) ?: return
        val fresh = seen.add(sbn.key)
        LinkService.instance?.onNotification(j, fresh)
    }
    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        seen.remove(sbn.key)
        LinkService.instance?.onNotificationRemoved(sbn.key)
    }

    /**
     * What the PC's list shows.
     *
     * Group summaries are normally left out: on a grouped notification (LINE,
     * Google Messages, Gmail…) the summary only repeats the last child. But an
     * app can also leave a summary behind after its children are gone, and then
     * the shade keeps a notification that the PC never showed and therefore
     * could never clear — so a summary with no children in its group is listed
     * (and can be dismissed).
     */
    fun items(): List<JSONObject> {
        val all = activeNotifications ?: return emptyList()
        val groupsWithChildren = HashSet<String>()
        all.forEach { sbn ->
            if (!isSummary(sbn)) sbn.groupKey?.let { groupsWithChildren.add(it) }
        }
        return all.filter { sbn ->
            !isSummary(sbn) || sbn.groupKey == null || sbn.groupKey !in groupsWithChildren
        }.sortedByDescending { it.postTime }.mapNotNull { serialize(it) }.take(80)
    }

    private fun isSummary(sbn: StatusBarNotification) =
        (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY) != 0

    private fun serialize(sbn: StatusBarNotification): JSONObject? {
        val n = sbn.notification
        if (sbn.packageName == packageName || sbn.isOngoing) return null
        if (isSummary(sbn) && sbn.groupKey != null && (activeNotifications ?: emptyArray()).any { it.groupKey == sbn.groupKey && !isSummary(it) }) return null
        val ex = n.extras
        val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: ""
        if (title.isBlank() && text.isBlank()) return null
        val pm = packageManager
        val app = runCatching { pm.getApplicationLabel(pm.getApplicationInfo(sbn.packageName, 0)).toString() }.getOrDefault(sbn.packageName)
        val icon = icons.getOrPut(sbn.packageName) { runCatching { Img.toB64(Img.drawable(pm.getApplicationIcon(sbn.packageName), 64), png = true) }.getOrNull() }
        val acts = JSONArray()
        var reply = false
        n.actions?.forEach { a -> if (a.remoteInputs?.isNotEmpty() == true) reply = true else acts.put(a.title?.toString() ?: "") }
        return JSONObject().put("key", sbn.key).put("app", app).put("pkg", sbn.packageName).put("title", title).put("text", text)
            .put("time", sbn.postTime).put("icon", icon ?: JSONObject.NULL).put("reply", reply).put("actions", acts)
    }

    private fun find(key: String) = activeNotifications?.firstOrNull { it.key == key }

    fun isActive(key: String) = find(key) != null

    /**
     * Cancels [key] ("*" = everything) and handles the group around it.
     *
     * Messaging apps post each message as a child of a group whose summary is a
     * separate notification carrying the same text. Cancelling only the child
     * leaves the app's summary in the shade, which is exactly what "the
     * notification won't go away" looks like. Cancelling the summary while other
     * children remain, on the other hand, cancels the whole group — so the
     * summary goes only once its last child is dismissed.
     *
     * Returns false with a reason when nothing was cancelled:
     *   "off"     → the notification listener is not enabled
     *   "missing" → the notification is already gone
     */
    fun dismiss(key: String): Pair<Boolean, String> {
        if (key.isEmpty()) return false to "missing"
        if (key == "*") {
            runCatching { cancelAllNotifications() }
            return true to ""
        }
        val target = find(key) ?: return false to "missing"
        val group = target.groupKey
        val siblings = if (group != null) (activeNotifications ?: emptyArray()).filter { it.groupKey == group } else emptyList()
        val otherChildren = siblings.filter { it.key != key && !isSummary(it) }
        runCatching { cancelNotification(key) }
        if (group != null && otherChildren.isEmpty()) {
            // Last message of the group: drop the summary with it.
            siblings.filter { isSummary(it) }.forEach { runCatching { cancelNotification(it.key) } }
        }
        return true to ""
    }

    fun reply(key: String, text: String): Boolean {
        val a = find(key)?.notification?.actions?.firstOrNull { it.remoteInputs?.isNotEmpty() == true } ?: return false
        return runCatching {
            val intent = Intent()
            val b = Bundle(); a.remoteInputs.forEach { b.putCharSequence(it.resultKey, text) }
            RemoteInput.addResultsToIntent(a.remoteInputs, intent, b)
            a.actionIntent.send(this, 0, intent); true
        }.getOrDefault(false)
    }

    fun action(key: String, index: Int) {
        val acts = find(key)?.notification?.actions?.filter { it.remoteInputs.isNullOrEmpty() } ?: return
        runCatching { acts.getOrNull(index)?.actionIntent?.send() }
    }
}

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val msgs = runCatching { Telephony.Sms.Intents.getMessagesFromIntent(intent) }.getOrNull() ?: return
        msgs.groupBy { it.originatingAddress ?: "" }.forEach { (addr, parts) ->
            LinkService.instance?.onSms(addr, parts.joinToString("") { it.messageBody ?: "" })
        }
    }
}

class PhoneReceiver : BroadcastReceiver() {
    @Suppress("DEPRECATION")
    override fun onReceive(context: Context, intent: Intent) {
        val st = when (intent.getStringExtra(TelephonyManager.EXTRA_STATE)) {
            TelephonyManager.EXTRA_STATE_RINGING -> "ringing"
            TelephonyManager.EXTRA_STATE_OFFHOOK -> "offhook"
            else -> "idle"
        }
        val num = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
        if (st == "ringing" && num == null) return
        LinkService.instance?.onCallState(st, num)
    }
}

class ActionReceiver : BroadcastReceiver() {
    companion object { const val STOP_RING = "com.orokichi.tsunagu.STOP_RING" }
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == STOP_RING) Ringer.current?.stop()
    }
}

/** "Share → PC に送る": files, photos and text from any app. */
class ShareActivity : Activity() {
    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val svc = LinkService.instance
        if (svc == null || !svc.connected()) {
            Toast.makeText(this, "PC と接続されていません", Toast.LENGTH_SHORT).show()
            if (Prefs.paired(this)) LinkService.start(this)
            finish(); return
        }
        val uris = ArrayList<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let { uris.add(it) }
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
        }
        if (uris.isEmpty()) {
            val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
            if (!text.isNullOrBlank()) {
                startService(Intent(this, LinkService::class.java).setAction(LinkService.ACTION_SEND_TEXT).putExtra(LinkService.EXTRA_TEXT, text))
                Toast.makeText(this, "PC のクリップボードに送りました", Toast.LENGTH_SHORT).show()
            }
        } else {
            val clip = ClipData.newRawUri("files", uris[0])
            uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
            startService(Intent(this, LinkService::class.java).setAction(LinkService.ACTION_SEND_URIS).apply {
                clipData = clip; addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            })
            Toast.makeText(this, "${uris.size} 件を PC に送信しています", Toast.LENGTH_SHORT).show()
        }
        finish()
    }
}

/** Invisible activity that reads the clipboard (only allowed while focused) and sends it. */
class ClipActivity : Activity() {
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) return
        val text = getSystemService(ClipboardManager::class.java).primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
        val svc = LinkService.instance
        val msg = when {
            svc == null || !svc.connected() -> "PC と接続されていません"
            text.isNullOrBlank() -> "クリップボードは空です"
            else -> { svc.sendClip(text); "PC にクリップボードを送りました" }
        }
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
        finish()
    }
}

class ClipTile : TileService() {
    override fun onStartListening() {
        qsTile?.apply { state = if (LinkService.instance?.connected() == true) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE; updateTile() }
    }
    @Suppress("DEPRECATION")
    override fun onClick() {
        val i = Intent(this, ClipActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE))
        else startActivityAndCollapse(i)
    }
}
