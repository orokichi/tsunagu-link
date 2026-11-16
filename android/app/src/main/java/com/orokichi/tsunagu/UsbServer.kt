package com.orokichi.tsunagu

import android.net.LocalServerSocket
import android.net.LocalSocket
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicLong

/**
 * USB cable transport.
 *
 * The phone publishes a local abstract socket. The PC's browser is an ADB host
 * over WebUSB, so with the cable plugged in it can open `localabstract:tsunagu-usb`
 * itself — no adb install on the PC, no Wi-Fi, no mobile data and no internet.
 * Frames are [length:u32 big-endian][utf8 JSON]: exactly the messages the
 * PeerJS and LAN transports carry, so every feature works unchanged.
 *
 * Access control:
 *  - Only adbd (uid 2000, or root) may connect; a normal app has no business
 *    here and is dropped before a byte is written. Abstract sockets have no
 *    file permissions, so this UID check is what keeps other apps out.
 *  - The first frame must carry SHA-256 hashes of the pairing secrets (the
 *    token this phone stored, plus the pairing code so a re-pairing works).
 *    Repeated failures lock the socket for a while.
 */
class UsbServer(
    private val authHashes: () -> Set<String>,
    private val hello: () -> JSONObject,
    private val onMessage: (JSONObject) -> Unit,
    private val onClosed: () -> Unit,
) {
    companion object {
        /** ADB service name: `localabstract:tsunagu-usb`. */
        const val NAME = "tsunagu-usb"
        private const val MAX_FRAME = 16 * 1024 * 1024
        private const val BACKLOG = 3_000_000L
        private const val MAX_FAILS = 5
        private const val LOCKOUT_MS = 60_000L
    }

    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "tsunagu-usb").apply { isDaemon = true } }
    private var server: LocalServerSocket? = null
    @Volatile private var running = false
    @Volatile private var current: Conn? = null
    private var fails = 0
    @Volatile private var lockUntil = 0L

    @Synchronized
    fun start() {
        if (running) return
        server = runCatching { LocalServerSocket(NAME) }.getOrNull() ?: return
        running = true
        pool.execute {
            while (running) {
                val sock = try { server?.accept() } catch (e: Exception) { null }
                if (sock == null) {
                    if (!running) break
                    Thread.sleep(150)
                    continue
                }
                pool.execute { runCatching { serve(sock) } }
            }
        }
    }

    fun stop() {
        running = false
        runCatching { server?.close() }
        server = null
        current?.close()
        current = null
    }

    /** true while a PC is attached over the cable. */
    val connected: Boolean get() = current?.open == true

    /** Queues [text] to the attached PC; returns the bytes still waiting, or -1. */
    fun send(text: String): Int = current?.send(text) ?: -1

    /** Bytes still queued for the writer thread (-1 when nothing is attached). */
    fun buffered(): Long = current?.buffered() ?: -1L

    // ------------------------------------------------------------------ session

    private fun serve(sock: LocalSocket) {
        // Only adbd (shell/root) — see the class comment.
        val uid = runCatching { sock.peerCredentials.uid }.getOrNull()
        if (uid != null && uid != 0 && uid != 2000) { closeQuietly(sock); return }
        if (System.currentTimeMillis() < lockUntil) { closeQuietly(sock); return }
        val input = runCatching { sock.inputStream }.getOrNull() ?: run { closeQuietly(sock); return }
        val first = readFrame(input)
        val auth = first?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (auth == null || auth.optString("t") != "usb_auth" || !authed(auth)) {
            fails++
            if (fails >= MAX_FAILS) { fails = 0; lockUntil = System.currentTimeMillis() + LOCKOUT_MS }
            runCatching { sock.outputStream.write(frame(JSONObject().put("t", "usb_denied").toString())) }
            closeQuietly(sock)
            return
        }
        fails = 0
        val conn = runCatching { Conn(sock) }.getOrNull() ?: run { closeQuietly(sock); return }
        // One cable session at a time: a new one replaces a stale/old one.
        val previous = current
        current = conn
        conn.start()
        conn.send(hello().toString())
        previous?.close()
        try {
            while (conn.open) {
                val text = readFrame(input) ?: break
                val m = runCatching { JSONObject(text) }.getOrNull() ?: continue
                runCatching { onMessage(m) }
            }
        } catch (e: Exception) {
            // cable unplugged / socket closed
        } finally {
            conn.close()
            if (current === conn) {
                current = null
                runCatching { onClosed() }
            }
        }
    }

    private fun authed(o: JSONObject): Boolean {
        val known = authHashes()
        if (known.isEmpty()) return false
        val arr = o.optJSONArray("auth") ?: return false
        for (i in 0 until arr.length()) if (arr.optString(i) in known) return true
        return false
    }

    /** [length:u32 BE][utf8 JSON], or null at end of stream / on a bad frame. */
    private fun readFrame(input: InputStream): String? {
        val head = ByteArray(4)
        var off = 0
        while (off < 4) {
            val n = try { input.read(head, off, 4 - off) } catch (e: Exception) { -1 }
            if (n <= 0) return null
            off += n
        }
        val len = ((head[0].toInt() and 0xFF) shl 24) or ((head[1].toInt() and 0xFF) shl 16) or
            ((head[2].toInt() and 0xFF) shl 8) or (head[3].toInt() and 0xFF)
        if (len <= 0 || len > MAX_FRAME) return null
        val body = ByteArray(len)
        off = 0
        while (off < len) {
            val n = try { input.read(body, off, len - off) } catch (e: Exception) { -1 }
            if (n <= 0) return null
            off += n
        }
        return String(body, Charsets.UTF_8)
    }

    private fun frame(text: String): ByteArray {
        val body = text.toByteArray(Charsets.UTF_8)
        val f = ByteArray(4 + body.size)
        f[0] = ((body.size ushr 24) and 0xFF).toByte()
        f[1] = ((body.size ushr 16) and 0xFF).toByte()
        f[2] = ((body.size ushr 8) and 0xFF).toByte()
        f[3] = (body.size and 0xFF).toByte()
        System.arraycopy(body, 0, f, 4, body.size)
        return f
    }

    private fun closeQuietly(sock: LocalSocket) = runCatching { sock.close() }

    /** One attached PC: a write queue drained by its own thread, plus the read side. */
    private inner class Conn(private val sock: LocalSocket) {
        private val out: OutputStream = sock.outputStream
        private val queue = LinkedBlockingQueue<ByteArray?>()
        private val queued = AtomicLong(0)
        @Volatile var open = true
            private set

        private val writer = Thread({
            try {
                while (true) {
                    val f = queue.take() ?: break
                    out.write(f)
                    out.flush()
                    queued.addAndGet(-f.size.toLong())
                }
            } catch (e: Exception) {
                // cable unplugged
            } finally {
                close()
            }
        }, "tsunagu-usb-writer").apply { isDaemon = true }

        fun start() {
            runCatching { writer.start() }
        }

        fun send(text: String): Int {
            if (!open) return -1
            val f = frame(text)
            queue.offer(f)
            val n = queued.addAndGet(f.size.toLong())
            if (n > BACKLOG * 8) { // the PC stopped reading: drop the session
                close()
                return -1
            }
            return n.toInt()
        }

        fun buffered(): Long = if (open) queued.get() else -1L

        fun close() {
            if (!open) return
            open = false
            queue.offer(null)
            runCatching { sock.close() }
        }
    }
}
