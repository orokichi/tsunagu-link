@file:OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalMaterial3Api::class)

package com.orokichi.tsunagu

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (Prefs.paired(this)) LinkService.start(this)
        setContent { TsunaguTheme { Root() } }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) return
        startService(Intent(this, LinkService::class.java).setAction(LinkService.ACTION_KICK).takeIf { Prefs.paired(this) } ?: return)
        window.decorView.postDelayed({
            val t = runCatching { getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(this)?.toString() }.getOrNull()
            if (!t.isNullOrBlank() && t != LinkService.lastClip) LinkService.instance?.takeIf { it.connected() }?.sendClip(t)
        }, 400)
    }
}

@Composable
fun TsunaguTheme(content: @Composable () -> Unit) {
    val ctx = LocalContext.current
    val scheme = if (isSystemInDarkTheme()) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
    MaterialExpressiveTheme(colorScheme = scheme, motionScheme = MotionScheme.expressive(), content = content)
}

@Composable
fun Root() {
    val ctx = LocalContext.current
    var paired by remember { mutableStateOf(Prefs.paired(ctx)) }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxSize()) {
        AnimatedContent(paired, transitionSpec = { (fadeIn() + scaleIn(initialScale = 0.92f)) togetherWith (fadeOut() + scaleOut(targetScale = 1.05f)) }, label = "root") { p ->
            if (p) HomeScreen(onUnpair = { LinkService.stop(ctx); Prefs.unpair(ctx); paired = false })
            else PairScreen(onPaired = { paired = true })
        }
    }
}

/* ---------------- Shapes ---------------- */
@Composable
fun MorphBadge(connected: Boolean, size: Int, icon: ImageVector) {
    val spin = rememberInfiniteTransition(label = "spin")
    val angle by spin.animateFloat(0f, 360f, infiniteRepeatable(tween(if (connected) 30000 else 6000, easing = LinearEasing), RepeatMode.Restart), label = "a")
    val cs = MaterialTheme.colorScheme
    Box(Modifier.size(size.dp), contentAlignment = Alignment.Center) {
        AnimatedContent(connected, transitionSpec = { scaleIn(initialScale = 0.6f) togetherWith scaleOut(targetScale = 0.6f) }, label = "shape") { c ->
            val shape = if (c) MaterialShapes.Cookie9Sided.toShape() else MaterialShapes.SoftBurst.toShape()
            Box(Modifier.fillMaxSize().rotate(angle).clip(shape).background(if (c) cs.primary else cs.tertiary))
        }
        Icon(icon, null, tint = if (connected) cs.onPrimary else cs.onTertiary, modifier = Modifier.size((size * 0.42f).dp))
    }
}

/* ---------------- Pairing ---------------- */
@Composable
fun PairScreen(onPaired: () -> Unit) {
    val ctx = LocalContext.current
    var code by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    fun pair(c: String, secret: String) {
        Prefs.pair(ctx, c, secret)
        LinkService.start(ctx); onPaired()
    }
    val scan = rememberLauncherForActivityResult(ScanContract()) { r ->
        val parts = r.contents?.split(":")
        if (parts != null && parts.size == 3 && parts[0] == "tsunagu") pair(parts[1], parts[2])
        else if (r.contents != null) err = "Tsunagu の QR コードではありません"
    }
    val notifPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) { notifPerm.launch(Manifest.permission.POST_NOTIFICATIONS) }

    Column(
        Modifier.fillMaxSize().systemBarsPadding().verticalScroll(rememberScrollState()).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Spacer(Modifier.height(24.dp))
        MorphBadge(false, 150, Icons.Rounded.Devices)
        Text("PC とつなぐ", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
        Text("PC のブラウザで tsunagu-link.vercel.app を開き、表示された QR コードをスキャンしてください。",
            style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(
            onClick = { scan.launch(ScanOptions().setPrompt("PC の QR コードを読み取る").setBeepEnabled(false).setOrientationLocked(false).setDesiredBarcodeFormats(ScanOptions.QR_CODE)) },
            shapes = ButtonDefaults.shapes(), modifier = Modifier.fillMaxWidth().height(64.dp)
        ) { Icon(Icons.Rounded.QrCodeScanner, null); Spacer(Modifier.width(10.dp)); Text("QR コードをスキャン", fontSize = 18.sp) }

        Card(shape = RoundedCornerShape(32.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest)) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("またはコードを入力", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                OutlinedTextField(
                    value = code, onValueChange = { code = it.uppercase().filter { ch -> ch.isLetterOrDigit() }.take(6); err = null },
                    label = { Text("6 文字のコード") }, singleLine = true, shape = RoundedCornerShape(20.dp),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters), modifier = Modifier.fillMaxWidth()
                )
                FilledTonalButton(onClick = { if (code.length == 6) pair(code, "") else err = "6 文字で入力してください" }, shapes = ButtonDefaults.shapes(), modifier = Modifier.fillMaxWidth().height(56.dp)) {
                    Icon(Icons.Rounded.Link, null); Spacer(Modifier.width(8.dp)); Text("接続（PC 側で許可）")
                }
            }
        }
        err?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

/* ---------------- Home ---------------- */
data class Perm(val icon: ImageVector, val title: String, val desc: String, val perms: List<String> = emptyList(), val special: String? = null)

val PERMS = listOf(
    Perm(Icons.Rounded.Notifications, "通知のミラー", "スマホの通知を PC に表示・返信・消去", special = "listener"),
    Perm(Icons.Rounded.Sms, "メッセージ (SMS)", "SMS の閲覧・PC からの送信・受信通知", listOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS)),
    Perm(Icons.Rounded.Call, "通話", "通話履歴・PC から発信・着信通知・拒否", listOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_PHONE_STATE, Manifest.permission.CALL_PHONE, Manifest.permission.ANSWER_PHONE_CALLS)),
    Perm(Icons.Rounded.Contacts, "連絡先", "番号に名前を表示", listOf(Manifest.permission.READ_CONTACTS)),
    Perm(Icons.Rounded.PhotoLibrary, "写真と動画", "最近の写真・動画を PC で閲覧・保存", listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO), special = "media"),
    Perm(Icons.Rounded.NotificationsActive, "アプリの通知", "受信ファイル・リンク・鳴らす機能の通知", listOf(Manifest.permission.POST_NOTIFICATIONS)),
    Perm(Icons.Rounded.BatterySaver, "バックグラウンドで常時接続", "電池の最適化を除外して接続を維持", special = "battery"),
    Perm(Icons.Rounded.OpenInNew, "リンクを直接開く", "PC から送ったリンクを即座に開く（他のアプリの上に表示）", special = "overlay"),
)

fun granted(ctx: Context, p: Perm): Boolean = when (p.special) {
    "listener" -> NotifListener.enabled(ctx)
    "battery" -> ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(ctx.packageName)
    "overlay" -> Settings.canDrawOverlays(ctx)
    // Partial ("selected photos") access counts: the chosen photos/videos are usable.
    "media" -> (ctx.checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED &&
        ctx.checkSelfPermission(Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED) ||
        (Build.VERSION.SDK_INT >= 34 && ctx.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED)
    else -> p.perms.all { ctx.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
}

@Composable
fun HomeScreen(onUnpair: () -> Unit) {
    val ctx = LocalContext.current
    val status by LinkService.status.collectAsState()
    val transfers by LinkService.transfers.collectAsState()
    var tick by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { tick++ }
    val req = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { tick++ }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val svc = LinkService.instance ?: return@rememberLauncherForActivityResult
        CoroutineScope(Dispatchers.IO).launch { uris.forEach { svc.sendUri(it) } }
    }
    val connected = status == "connected"
    var confirmUnpair by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
        topBar = {
            TopAppBar(title = { Text("Tsunagu", fontWeight = FontWeight.Bold) }, actions = {
                IconButton(onClick = { confirmUnpair = true }) { Icon(Icons.Rounded.LinkOff, "ペアリング解除") }
            }, colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainer))
        }
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            // Hero status
            Card(shape = RoundedCornerShape(40.dp), colors = CardDefaults.cardColors(containerColor = if (connected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.tertiaryContainer),
                modifier = Modifier.fillMaxWidth().animateContentSize()) {
                Row(Modifier.padding(24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    if (connected) MorphBadge(true, 88, Icons.Rounded.Computer)
                    else Box(Modifier.size(88.dp), contentAlignment = Alignment.Center) { LoadingIndicator(Modifier.size(80.dp)) }
                    Column(Modifier.weight(1f)) {
                        Text(if (connected) "接続中" else "PC を探しています", style = MaterialTheme.typography.labelLarge)
                        Text(if (connected) Prefs.pcName(ctx) else "PC でページを開いてください", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                        Text("コード ${Prefs.code(ctx) ?: ""}", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            // Quick actions (connected button group)
            Row(horizontalArrangement = Arrangement.spacedBy(ButtonGroupDefaults.ConnectedSpaceBetween), modifier = Modifier.fillMaxWidth()) {
                ToggleButton(checked = false, onCheckedChange = { pick.launch(arrayOf("*/*")) }, enabled = connected,
                    shapes = ButtonGroupDefaults.connectedLeadingButtonShapes(), modifier = Modifier.weight(1f).height(64.dp)) {
                    Icon(Icons.Rounded.UploadFile, null); Spacer(Modifier.width(8.dp)); Text("ファイル送信")
                }
                ToggleButton(checked = false, onCheckedChange = {
                    ctx.startActivity(Intent(ctx, ClipActivity::class.java))
                }, enabled = connected, shapes = ButtonGroupDefaults.connectedTrailingButtonShapes(), modifier = Modifier.weight(1f).height(64.dp)) {
                    Icon(Icons.Rounded.ContentPasteGo, null); Spacer(Modifier.width(8.dp)); Text("クリップボード")
                }
            }

            AnimatedVisibility(transfers.isNotEmpty()) {
                Card(shape = RoundedCornerShape(28.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest)) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("ファイル転送", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        transfers.take(5).forEach { t ->
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Icon(if (t.incoming) Icons.Rounded.Download else Icons.Rounded.Upload, null, tint = MaterialTheme.colorScheme.primary)
                                Column(Modifier.weight(1f)) {
                                    Text(t.name, maxLines = 1, style = MaterialTheme.typography.bodyMedium)
                                    when (t.state) {
                                        "active" -> LinearWavyProgressIndicator(progress = { if (t.size > 0) (t.done.toFloat() / t.size).coerceIn(0f, 1f) else 0f }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
                                        "done" -> Text(if (t.incoming) "ダウンロード/Tsunagu に保存" else "PC に送信しました", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        else -> Text("失敗しました", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Permissions
            val states = remember(tick) { PERMS.map { granted(ctx, it) } }
            val missing = PERMS.filterIndexed { i, p -> !states[i] && (p.special == null || p.special == "media") }.flatMap { it.perms }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp, start = 4.dp)) {
                Text("連携する機能", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                if (missing.isNotEmpty()) Button(onClick = { req.launch(missing.toTypedArray()) }, shapes = ButtonDefaults.shapes()) { Text("まとめて許可") }
            }
            Card(shape = RoundedCornerShape(32.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest)) {
                Column(Modifier.padding(vertical = 8.dp)) {
                    PERMS.forEachIndexed { i, p ->
                        val ok = states[i]
                        ListItem(
                            leadingContent = {
                                Box(Modifier.size(44.dp).clip(if (ok) MaterialShapes.Cookie9Sided.toShape() else CircleShape)
                                    .background(if (ok) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
                                    Icon(p.icon, null, tint = if (ok) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            },
                            headlineContent = { Text(p.title, fontWeight = FontWeight.SemiBold) },
                            supportingContent = { Text(p.desc) },
                            trailingContent = {
                                if (ok) Icon(Icons.Rounded.CheckCircle, "許可済み", tint = MaterialTheme.colorScheme.primary)
                                else FilledTonalButton(onClick = { grant(ctx, p) { req.launch(it) } }, shapes = ButtonDefaults.shapes()) { Text("許可") }
                            },
                            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest)
                        )
                    }
                }
            }
            Card(shape = RoundedCornerShape(28.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
                Row(Modifier.padding(18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Icon(Icons.Rounded.Info, null)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("SMS・通話・通知が「制限付き設定」で許可できない場合は、アプリ情報の右上メニューから「制限付き設定を許可」を選んでください。", style = MaterialTheme.typography.bodyMedium)
                        TextButton(onClick = { ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))) }) { Text("アプリ情報を開く") }
                        Text("クイック設定に「クリップボードを PC へ」タイルを追加すると、どこからでも送れます。共有メニューの「PC に送る」でファイルや写真も送れます。", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
            val ver = remember { runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() }
            if (ver != null) Text("Tsunagu v$ver", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(24.dp))
        }
    }
    if (confirmUnpair) AlertDialog(
        onDismissRequest = { confirmUnpair = false },
        icon = { Icon(Icons.Rounded.LinkOff, null) },
        title = { Text("ペアリングを解除") }, text = { Text("この PC との接続設定を削除します。") },
        confirmButton = { TextButton(onClick = { confirmUnpair = false; onUnpair() }) { Text("解除") } },
        dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("キャンセル") } }
    )
}

@android.annotation.SuppressLint("BatteryLife")
fun grant(ctx: Context, p: Perm, request: (Array<String>) -> Unit) {
    when (p.special) {
        "listener" -> ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        "battery" -> ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
        "overlay" -> ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")))
        // Re-requesting lets the user widen a partial ("selected photos") grant or allow all.
        "media" -> request(p.perms.toTypedArray())
        else -> request(p.perms.toTypedArray())
    }
}
