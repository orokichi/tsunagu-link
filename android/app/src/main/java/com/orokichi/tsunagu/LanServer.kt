package com.orokichi.tsunagu

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

fun sha256Hex(s: String): String =
    MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

/**
 * Tiny authenticated HTTP endpoint used only for LAN *signaling*.
 *
 * The PC web app (served over HTTPS) asks this phone, on the same Wi-Fi/LAN,
 * to answer a WebRTC offer; once the data channel is up, all traffic flows
 * peer-to-peer over the LAN and the internet is no longer involved.
 *
 * Browser constraints handled here:
 *  - Private Network Access: preflights arrive with
 *    `Access-Control-Request-Private-Network: true` and are only allowed when
 *    the response carries `Access-Control-Allow-Private-Network: true`.
 *  - Plain CORS for the actual POSTs (Origin is echoed back).
 *
 * Authentication: callers present SHA-256 hashes of pairing secrets they know
 * (the pairing secret / PC-issued tokens). The phone accepts when one hash
 * equals SHA-256 of the token it stores. Hashes of ~100-bit secrets are not
 * brute-forceable, and nothing else is exposed: /ping answers only after auth.
 */
class LanServer(
    private val authHashes: () -> Set<String>,
    private val deviceName: () -> String,
    private val onOffer: (String) -> String?,
) {
    companion object { val PORTS = intArrayOf(47822, 47823, 47824) }

    @Volatile var port: Int = 0
        private set

    private var server: ServerSocket? = null
    @Volatile private var running = false
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "tsunagu-lan").apply { isDaemon = true } }
    private val lastOfferAt = AtomicLong(0)

    fun start() {
        if (running) return
        for (p in PORTS) {
            try {
                val s = ServerSocket()
                s.reuseAddress = true
                s.bind(InetSocketAddress(p))
                server = s; port = p
                break
            } catch (e: Exception) { /* try next port */ }
        }
        val srv = server ?: return
        running = true
        pool.execute {
            while (running) {
                try {
                    val sock = srv.accept()
                    pool.execute { runCatching { handle(sock) } }
                } catch (e: Exception) {
                    if (!running) break
                }
            }
        }
    }

    fun stop() {
        running = false
        runCatching { server?.close() }
        server = null
        port = 0
    }

    private fun handle(sock: Socket) {
        sock.soTimeout = 15_000
        val input = BufferedInputStream(sock.getInputStream())
        val out = sock.getOutputStream()
        // ---- request line + headers ----
        val head = ByteArrayOutputStream()
        var matched = 0
        while (true) {
            val b = input.read()
            if (b < 0) { sock.close(); return }
            head.write(b)
            matched = when {
                b == '\r'.code && (matched == 0 || matched == 2) -> matched + 1
                b == '\n'.code && (matched == 1 || matched == 3) -> matched + 1
                else -> 0
            }
            if (matched == 4) break
            if (head.size() > 16 * 1024) { sock.close(); return }
        }
        val lines = head.toString(Charsets.ISO_8859_1).split("\r\n")
        val parts = lines[0].split(" ")
        if (parts.size < 2) { sock.close(); return }
        val method = parts[0]; val path = parts[1]
        val headers = HashMap<String, String>()
        for (i in 1 until lines.size) {
            val idx = lines[i].indexOf(':')
            if (idx > 0) headers[lines[i].substring(0, idx).trim().lowercase()] = lines[i].substring(idx + 1).trim()
        }
        val origin = headers["origin"] ?: "*"

        if (method == "OPTIONS") {
            respond(out, 204, "", origin, preflight = true)
            sock.close(); return
        }
        if (method != "POST" || (path != "/ping" && path != "/signal")) {
            respond(out, 404, """{"error":"not found"}""", origin)
            sock.close(); return
        }
        val len = headers["content-length"]?.toIntOrNull() ?: 0
        if (len <= 0 || len > 128 * 1024) {
            respond(out, 400, """{"error":"bad length"}""", origin)
            sock.close(); return
        }
        val bodyBytes = ByteArray(len)
        var off = 0
        while (off < len) {
            val n = input.read(bodyBytes, off, len - off)
            if (n < 0) break
            off += n
        }
        val body = runCatching { JSONObject(String(bodyBytes, Charsets.UTF_8)) }.getOrNull()
        if (body == null || !authed(body)) {
            respond(out, 403, """{"error":"unauthorized"}""", origin)
            sock.close(); return
        }
        when (path) {
            "/ping" -> respond(out, 200, JSONObject().put("ok", true).put("name", deviceName()).toString(), origin)
            "/signal" -> {
                val now = System.currentTimeMillis()
                val prev = lastOfferAt.get()
                if (now - prev < 1200) {
                    respond(out, 429, """{"error":"busy"}""", origin)
                    sock.close(); return
                }
                lastOfferAt.set(now)
                val sdp = body.optString("sdp")
                if (sdp.isBlank() || sdp.length > 64 * 1024) {
                    respond(out, 400, """{"error":"bad sdp"}""", origin)
                    sock.close(); return
                }
                // Blocks until the WebView bridge produces the answer (or times out).
                val answer = onOffer(sdp)
                if (answer.isNullOrBlank()) respond(out, 504, """{"error":"no answer"}""", origin)
                else respond(out, 200, JSONObject().put("sdp", answer).toString(), origin)
            }
        }
        sock.close()
    }

    private fun authed(body: JSONObject): Boolean {
        val known = authHashes()
        if (known.isEmpty()) return false
        val arr = body.optJSONArray("auth") ?: return false
        for (i in 0 until arr.length()) {
            if (arr.optString(i) in known) return true
        }
        return false
    }

    private fun respond(out: java.io.OutputStream, code: Int, body: String, origin: String, preflight: Boolean = false) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val reason = when (code) { 200 -> "OK"; 204 -> "No Content"; 400 -> "Bad Request"; 403 -> "Forbidden"; 404 -> "Not Found"; 429 -> "Too Many Requests"; else -> "Gateway Timeout" }
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n")
        sb.append("Access-Control-Allow-Origin: ").append(origin).append("\r\n")
        sb.append("Access-Control-Allow-Methods: POST, OPTIONS\r\n")
        sb.append("Access-Control-Allow-Headers: Content-Type\r\n")
        // Private Network Access: without this header Chrome refuses to let a
        // public HTTPS page talk to this private address at all.
        sb.append("Access-Control-Allow-Private-Network: true\r\n")
        if (!preflight) {
            sb.append("Content-Type: application/json\r\n")
            sb.append("Content-Length: ").append(bytes.size).append("\r\n")
        } else {
            sb.append("Content-Length: 0\r\n")
        }
        sb.append("Connection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        if (!preflight && bytes.isNotEmpty()) out.write(bytes)
        out.flush()
    }
}
