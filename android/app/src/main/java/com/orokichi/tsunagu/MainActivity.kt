@file:OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

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
    companion object {
        /** "fix" = get a position now / "always" = allow location all the time. */
        const val EXTRA_LOC = "loc"
    }

    /** What the user asked for before the permission dialog opened. */
    private var locAsk: String? = null

    /** 位置情報 step 1: 使用中のみ (fine/coarse). */
    private val locPerm = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { r ->
        val ok = r[Manifest.permission.ACCESS_FINE_LOCATION] == true || r[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        val want = locAsk
        locAsk = null
        if (!ok) { android.widget.Toast.makeText(this, "位置情報が許可されませんでした", android.widget.Toast.LENGTH_SHORT).show(); return@registerForActivityResult }
        // The app is visible now: the running link service may take the location
        // service type, which keeps 「探す」 working in the background.
        LinkService.instance?.promoteLocation()
        if (want == "always" && !Features.locAlways(this)) askBackground() else LinkService.instance?.sendLocation()
    }

    /** 位置情報 step 2: 常に許可。Android 11+ では設定画面へ案内するダイアログになる。 */
    private val bgPerm = registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
        LinkService.instance?.sendLocation()
    }

    private fun askLoc(want: String) {
        locAsk = want
        if (Features.locGranted(this)) {
            locAsk = null
            LinkService.instance?.promoteLocation()
            if (want == "always" && !Features.locAlways(this)) askBackground() else LinkService.instance?.sendLocation()
        } else {
            locPerm.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        }
    }

    private fun askBackground() {
        android.widget.Toast.makeText(this, "次の画面で「位置情報」→「常に許可」を選んでください", android.widget.Toast.LENGTH_LONG).show()
        runCatching { bgPerm.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }
    }

    /** Opened from the PC's 「探す」 screen (`EXTRA_LOC`). */
    private fun handleLoc(i: Intent?) {
        when (i?.getStringExtra(EXTRA_LOC)) {
            "fix" -> askLoc("fix")
            "always" -> askLoc("always")
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLoc(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (Prefs.paired(this)) LinkService.start(this)
        setContent { TsunaguTheme { Root() } }
        handleLoc(intent)
    }

    override fun onResume() {
        super.onResume()
        LinkService.appVisible = true
        LinkService.instance?.promoteLocation()
    }

    override fun onPause() {
        LinkService.appVisible = false
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) return
        startService(Intent(this, LinkService::class.java).setAction(LinkService.ACTION_KICK).takeIf { Prefs.paired(this) } ?: return)
        // Permissions may have changed in system settings: report quick-settings state again.
        LinkService.instance?.scheduleSysPush()
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

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) { Column(
        Modifier.widthIn(max = 600.dp).fillMaxSize().systemBarsPadding().verticalScroll(rememberScrollState()).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Spacer(Modifier.height(24.dp))
        MorphBadge(false, 150, Icons.Rounded.Devices)
        Text("PC とつなぐ", style = MaterialTheme.typography.displayMedium, fontWeight = FontWeight.Black)
        Text("PC のブラウザで tsunagu-link.vercel.app を開き、表示された QR コードをスキャンしてください。",
            style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("コードの入力は初回だけです。次回からは、同じ Wi-Fi につながっていれば自動で接続します。",
            style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
    } }
}

/* ---------------- Home ---------------- */
data class Perm(val icon: ImageVector, val title: String, val desc: String, val perms: List<String> = emptyList(), val special: String? = null)

val PERMS = listOf(
    Perm(Icons.Rounded.Notifications, "通知のミラー", "スマホの通知を PC に表示・返信・消去", special = "listener"),
    Perm(Icons.Rounded.Sms, "メッセージ (SMS)", "SMS の閲覧・PC からの送信・受信通知", listOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS)),
    Perm(Icons.Rounded.Call, "通話", "通話履歴・PC から発信・着信通知・拒否", listOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_PHONE_STATE, Manifest.permission.CALL_PHONE, Manifest.permission.ANSWER_PHONE_CALLS)),
    Perm(Icons.Rounded.Contacts, "連絡先", "番号に名前を表示", listOf(Manifest.permission.READ_CONTACTS)),
    Perm(Icons.Rounded.PhotoLibrary, "写真と動画", "最近の写真・動画を PC で閲覧・保存", listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO), special = "media"),
    Perm(Icons.Rounded.Folder, "エクスプローラー（全ファイル）", "スマホ内のファイルを PC から閲覧・送受信・削除・名前変更", special = "allfiles"),
    Perm(Icons.Rounded.MyLocation, "位置情報", "「探す」でスマホの現在地を PC の地図（OpenStreetMap）に表示", listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)),
    Perm(Icons.Rounded.LocationSearching, "位置情報（常に許可）", "アプリを開いていないときも「探す」で現在地を取得します", special = "location_always"),
    Perm(Icons.Rounded.NotificationsActive, "アプリの通知", "受信ファイル・リンク・鳴らす機能の通知", listOf(Manifest.permission.POST_NOTIFICATIONS)),
    Perm(Icons.Rounded.BatterySaver, "バックグラウンドで常時接続", "電池の最適化を除外して接続を維持", special = "battery"),
    Perm(Icons.Rounded.OpenInNew, "リンクを直接開く", "PC から送ったリンクを即座に開く（他のアプリの上に表示）", special = "overlay"),
    Perm(Icons.Rounded.ScreenRotation, "システム設定の変更", "PC のクイック設定から自動回転を切り替え", special = "write_settings"),
    Perm(Icons.Rounded.DoNotDisturbOn, "サイレントモードへのアクセス", "PC からマナーモード（ミュート）とサイレントモードを切り替え", special = "dnd"),
)

fun granted(ctx: Context, p: Perm): Boolean = when (p.special) {
    "listener" -> NotifListener.enabled(ctx)
    "battery" -> ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(ctx.packageName)
    "overlay" -> Settings.canDrawOverlays(ctx)
    "allfiles" -> android.os.Environment.isExternalStorageManager()
    "write_settings" -> SysControls.canWrite(ctx)
    "dnd" -> SysControls.dndAccess(ctx)
    "location_always" -> Features.locAlways(ctx)
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
    val via by LinkService.via.collectAsState()
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
            TopAppBar(title = { Text("Tsunagu", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Black) }, actions = {
                IconButton(onClick = { confirmUnpair = true }) { Icon(Icons.Rounded.LinkOff, "ペアリング解除") }
            }, colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainer))
        }
    ) { pad ->
        // Adaptive layout: one column on phones, two panes on tablets / unfolded
        // foldables (≥600dp), with wider gutters on expanded widths (≥840dp).
        BoxWithConstraints(Modifier.padding(pad).fillMaxSize()) {
            val twoPane = maxWidth >= 600.dp
            val gutter = if (maxWidth >= 840.dp) 24.dp else 16.dp
            val primary: @Composable ColumnScope.() -> Unit = {
                StatusHero(connected, via)
                QuickActions(connected, onFiles = { pick.launch(arrayOf("*/*")) }, onClip = { ctx.startActivity(Intent(ctx, ClipActivity::class.java)) })
                PcCard(connected)
                TransfersCard(transfers)
            }
            val secondary: @Composable ColumnScope.() -> Unit = {
                PermissionsSection(tick, request = { req.launch(it) })
                TipsCard()
                val ver = remember { runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() }
                if (ver != null) Text("Tsunagu v$ver", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(24.dp))
            }
            if (twoPane) {
                Row(Modifier.fillMaxSize().padding(horizontal = gutter), horizontalArrangement = Arrangement.spacedBy(gutter)) {
                    Column(Modifier.weight(1.1f).fillMaxHeight().verticalScroll(rememberScrollState()).padding(vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp), content = primary)
                    Column(Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()).padding(vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp), content = secondary)
                }
            } else {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)) { primary(); secondary() }
            }
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

@Composable
fun StatusHero(connected: Boolean, via: String) {
    val ctx = LocalContext.current
    val cs = MaterialTheme.colorScheme
    Card(shape = RoundedCornerShape(48.dp), colors = CardDefaults.cardColors(containerColor = if (connected) cs.primaryContainer else cs.tertiaryContainer),
        modifier = Modifier.fillMaxWidth().animateContentSize()) {
        Row(Modifier.padding(24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            if (connected) MorphBadge(true, 96, Icons.Rounded.Computer)
            else Box(Modifier.size(96.dp), contentAlignment = Alignment.Center) { LoadingIndicator(Modifier.size(88.dp)) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(if (connected) "接続中" else "PC を探しています", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                Text(if (connected) Prefs.pcName(ctx) else "PC でページを開いてください", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
                Text("コード ${Prefs.code(ctx) ?: ""}", style = MaterialTheme.typography.bodyMedium)
                if (connected && via.isNotEmpty()) Text(
                    when (via) {
                        "lan" -> "同じネットワークで直接接続中"
                        "usb" -> "USB ケーブルで接続中"
                        else -> "クラウド経由で接続中"
                    },
                    style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
fun QuickActions(connected: Boolean, onFiles: () -> Unit, onClip: () -> Unit) {
    // Connected button group (Expressive): shapes morph on press.
    Row(horizontalArrangement = Arrangement.spacedBy(ButtonGroupDefaults.ConnectedSpaceBetween), modifier = Modifier.fillMaxWidth()) {
        ToggleButton(checked = false, onCheckedChange = { onFiles() }, enabled = connected,
            shapes = ButtonGroupDefaults.connectedLeadingButtonShapes(), modifier = Modifier.weight(1f).height(72.dp)) {
            Icon(Icons.Rounded.Share, null); Spacer(Modifier.width(8.dp)); Text("PC にファイルを送る", maxLines = 2)
        }
        ToggleButton(checked = false, onCheckedChange = { onClip() }, enabled = connected,
            shapes = ButtonGroupDefaults.connectedTrailingButtonShapes(), modifier = Modifier.weight(1f).height(72.dp)) {
            Icon(Icons.Rounded.ContentPasteGo, null); Spacer(Modifier.width(8.dp)); Text("クリップボードを送る", maxLines = 2)
        }
    }
}

@Composable
private fun InfoPill(icon: ImageVector, text: String, highlight: Boolean = false) {
    val cs = MaterialTheme.colorScheme
    Row(
        Modifier.clip(RoundedCornerShape(14.dp)).background(if (highlight) cs.primaryContainer else cs.surfaceContainerHigh).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Icon(icon, null, Modifier.size(18.dp), tint = if (highlight) cs.onPrimaryContainer else cs.primary)
        Text(text, style = MaterialTheme.typography.labelLarge, color = if (highlight) cs.onPrimaryContainer else cs.onSurface)
    }
}

/** The connected PC: what it is, and what this phone can do to it. */
@Composable
fun PcCard(connected: Boolean) {
    val pc by LinkService.pc.collectAsState()
    val ringing by LinkService.pcRinging.collectAsState()
    var text by remember { mutableStateOf("") }
    val cs = MaterialTheme.colorScheme
    val svc = LinkService.instance
    val enabled = connected && svc != null
    Card(shape = RoundedCornerShape(40.dp), colors = CardDefaults.cardColors(containerColor = cs.surfaceContainerLowest), modifier = Modifier.fillMaxWidth().animateContentSize()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(Modifier.size(56.dp).clip(MaterialShapes.Cookie9Sided.toShape()).background(cs.secondaryContainer), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Computer, null, tint = cs.onSecondaryContainer)
                }
                Column(Modifier.weight(1f)) {
                    Text("この PC", style = MaterialTheme.typography.labelLarge, color = cs.primary, fontWeight = FontWeight.Bold)
                    Text(pc?.optString("name")?.takeIf { it.isNotEmpty() } ?: if (connected) "PC" else "未接続",
                        style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    val sub = listOfNotNull(pc?.optString("browser")?.takeIf { it.isNotEmpty() }, pc?.optString("os")?.takeIf { it.isNotEmpty() }).joinToString(" · ")
                    if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                }
                IconButton(onClick = { svc?.pcRefresh() }, enabled = enabled) { Icon(Icons.Rounded.Refresh, "PC の情報を更新") }
            }
            pc?.let { p ->
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (!p.isNull("battery")) {
                        val charging = p.optBoolean("charging")
                        InfoPill(if (charging) Icons.Rounded.BatteryChargingFull else Icons.Rounded.BatteryFull, "バッテリー ${p.optInt("battery")}%" + if (charging) "（充電中）" else "")
                    }
                    val online = p.optBoolean("online", true)
                    InfoPill(if (online) Icons.Rounded.Wifi else Icons.Rounded.WifiOff, if (online) "オンライン" else "オフライン", highlight = online)
                    val visible = p.optBoolean("visible", true)
                    InfoPill(if (visible) Icons.Rounded.Visibility else Icons.Rounded.VisibilityOff, if (visible) "Tsunagu を表示中" else "バックグラウンド")
                    p.optString("screen").takeIf { it.isNotEmpty() }?.let { InfoPill(Icons.Rounded.DesktopWindows, it) }
                    if (p.optBoolean("pwa")) InfoPill(Icons.Rounded.Apps, "アプリとして実行中")
                }
            }
            OutlinedTextField(
                value = text, onValueChange = { text = it }, enabled = enabled,
                label = { Text("PC に送るリンクやテキスト") }, shape = RoundedCornerShape(24.dp), maxLines = 4,
                modifier = Modifier.fillMaxWidth()
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                FilledTonalButton(onClick = { svc?.pcOpenUrl(text); text = "" }, enabled = enabled && text.isNotBlank(), shapes = ButtonDefaults.shapes(), modifier = Modifier.weight(1f).height(52.dp)) {
                    Icon(Icons.Rounded.OpenInBrowser, null); Spacer(Modifier.width(6.dp)); Text("PC で開く", maxLines = 1)
                }
                FilledTonalButton(onClick = { svc?.pcText(text); text = "" }, enabled = enabled && text.isNotBlank(), shapes = ButtonDefaults.shapes(), modifier = Modifier.weight(1f).height(52.dp)) {
                    Icon(Icons.Rounded.TextFields, null); Spacer(Modifier.width(6.dp)); Text("テキストを送る", maxLines = 1)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(ButtonGroupDefaults.ConnectedSpaceBetween), modifier = Modifier.fillMaxWidth()) {
                ToggleButton(checked = false, onCheckedChange = { svc?.pcPing(text); text = "" }, enabled = enabled,
                    shapes = ButtonGroupDefaults.connectedLeadingButtonShapes(), modifier = Modifier.weight(1f).height(60.dp)) {
                    Icon(Icons.Rounded.NotificationImportant, null); Spacer(Modifier.width(6.dp)); Text("PC に通知", maxLines = 1)
                }
                ToggleButton(checked = ringing, onCheckedChange = { svc?.pcRing(it) }, enabled = enabled,
                    shapes = ButtonGroupDefaults.connectedTrailingButtonShapes(), modifier = Modifier.weight(1f).height(60.dp)) {
                    Icon(if (ringing) Icons.Rounded.Stop else Icons.Rounded.NotificationsActive, null); Spacer(Modifier.width(6.dp))
                    Text(if (ringing) "停止" else "PC を鳴らす", maxLines = 1)
                }
            }
            Text("ファイルは上の「PC にファイルを送る」、または各アプリの共有メニュー →「PC に送る」で送れます。「PC に通知」は入力中のテキストを通知の本文にします。",
                style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
    }
}

@Composable
fun TransfersCard(transfers: List<Transfer>) {
    AnimatedVisibility(transfers.isNotEmpty()) {
        Card(shape = RoundedCornerShape(32.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest)) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("ファイル転送", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
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
}

@Composable
fun PermissionsSection(tick: Int, request: (Array<String>) -> Unit) {
    val ctx = LocalContext.current
    val states = remember(tick) { PERMS.map { granted(ctx, it) } }
    val missing = PERMS.filterIndexed { i, p -> !states[i] && (p.special == null || p.special == "media") }.flatMap { it.perms }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp, start = 4.dp)) {
        Column(Modifier.weight(1f)) {
            Text("連携する機能", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Black)
            Text("${states.count { it }} / ${PERMS.size} 件を許可済み", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (missing.isNotEmpty()) Button(onClick = { request(missing.toTypedArray()) }, shapes = ButtonDefaults.shapes()) { Text("まとめて許可") }
    }
    Card(shape = RoundedCornerShape(36.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest)) {
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
                        else FilledTonalButton(onClick = { grant(ctx, p, request) }, shapes = ButtonDefaults.shapes()) { Text("許可") }
                    },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest)
                )
            }
        }
    }
}

@Composable
fun TipsCard() {
    val ctx = LocalContext.current
    Card(shape = RoundedCornerShape(32.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Row(Modifier.padding(20.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Icon(Icons.Rounded.Info, null)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("SMS・通話・通知が「制限付き設定」で許可できない場合は、アプリ情報の右上メニューから「制限付き設定を許可」を選んでください。", style = MaterialTheme.typography.bodyMedium)
                TextButton(onClick = { ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))) }) { Text("アプリ情報を開く") }
                Text("クイック設定に「クリップボードを PC へ」タイルを追加すると、どこからでも送れます。共有メニューの「PC に送る」でファイルや写真も送れます。", style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@android.annotation.SuppressLint("BatteryLife")
fun grant(ctx: Context, p: Perm, request: (Array<String>) -> Unit) {
    when (p.special) {
        "listener" -> ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        "battery" -> ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
        "overlay" -> ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")))
        "allfiles" -> {
            val ok = runCatching { ctx.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${ctx.packageName}"))) }.isSuccess
            if (!ok) runCatching { ctx.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
        }
        "write_settings" -> runCatching { ctx.startActivity(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:${ctx.packageName}"))) }
        "dnd" -> runCatching { ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)) }
        // 常に許可 has no runtime dialog on Android 11+: the app asks in the
        // foreground and, when needed, sends the user to the location settings.
        "location_always" -> ctx.startActivity(Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(MainActivity.EXTRA_LOC, "always"))
        // Re-requesting lets the user widen a partial ("selected photos") grant or allow all.
        "media" -> request(p.perms.toTypedArray())
        else -> request(p.perms.toTypedArray())
    }
}
