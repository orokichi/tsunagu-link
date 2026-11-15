package com.orokichi.tsunagu

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class PushSubscriptionData(
    val token: String,
    val endpoint: String,
    val p256dh: String,
    val auth: String,
)

/**
 * Web Push subscriptions and the phone's own VAPID identity.
 *
 * The phone is the application server: it keeps one VAPID key pair and, per
 * paired PC (identified by the pairing token issued at welcome time), the
 * browser PushSubscription that PC handed over the paired connection. The
 * private key and subscription secrets live only in this app-private
 * preferences file and are never logged or sent anywhere.
 */
object WebPushStore {
    private const val FILE = "tsunagu_push"
    private const val KEY_PUBLIC = "vapid_public"
    private const val KEY_PRIVATE = "vapid_private"
    private const val KEY_SUBS = "subscriptions"
    private const val MAX_SUBS = 10

    private fun prefs(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    @Synchronized
    fun keyPair(c: Context): Pair<String, String> {
        val p = prefs(c)
        val pub = p.getString(KEY_PUBLIC, null)
        val priv = p.getString(KEY_PRIVATE, null)
        if (pub != null && priv != null && isPublicKey(pub) && isPrivateKey(priv)) return pub to priv
        val generated = generateKeyPair()
        p.edit().putString(KEY_PUBLIC, generated.first).putString(KEY_PRIVATE, generated.second).apply()
        return generated
    }

    fun vapidPublic(c: Context): String = keyPair(c).first

    private fun isPublicKey(s: String): Boolean = runCatching {
        val b = b64Decode(s); b.size == 65 && b[0].toInt() == 4
    }.getOrDefault(false)

    private fun isPrivateKey(s: String): Boolean = runCatching { b64Decode(s).size == 32 }.getOrDefault(false)

    private fun generateKeyPair(): Pair<String, String> {
        val gen = KeyPairGenerator.getInstance("EC")
        gen.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())
        val kp = gen.generateKeyPair()
        val pub = kp.public as ECPublicKey
        val priv = kp.private as ECPrivateKey
        return b64Encode(publicKeyBytes(pub)) to b64Encode(fixed32(priv.s.toByteArray()))
    }

    @Synchronized
    fun saveSubscription(c: Context, token: String, subscription: JSONObject): Boolean {
        if (token.isBlank()) return false
        val endpoint = subscription.optString("endpoint")
        val keys = subscription.optJSONObject("keys") ?: return false
        val p256dh = keys.optString("p256dh")
        val auth = keys.optString("auth")
        if (!endpoint.startsWith("https://")) return false
        val valid = runCatching {
            b64Decode(p256dh).size == 65 && b64Decode(auth).size >= 16
        }.getOrDefault(false)
        if (!valid) return false
        val arr = readRaw(c)
        // An endpoint identifies one browser subscription: it can only belong
        // to the most recent pairing token that presented it.
        val kept = JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString("endpoint") != endpoint) kept.put(o)
        }
        kept.put(JSONObject().put("token", token).put("endpoint", endpoint).put("p256dh", p256dh).put("auth", auth))
        while (kept.length() > MAX_SUBS) kept.remove(0)
        prefs(c).edit().putString(KEY_SUBS, kept.toString()).apply()
        return true
    }

    @Synchronized
    fun removeSubscription(c: Context, token: String, endpoint: String) {
        val arr = readRaw(c)
        val kept = JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val match = (endpoint.isNotEmpty() && o.optString("endpoint") == endpoint) ||
                (endpoint.isEmpty() && token.isNotEmpty() && o.optString("token") == token)
            if (!match) kept.put(o)
        }
        prefs(c).edit().putString(KEY_SUBS, kept.toString()).apply()
    }

    @Synchronized
    fun clearToken(c: Context, token: String) {
        if (token.isNotEmpty()) removeSubscription(c, token, "")
    }

    /** Pairing was removed on the phone: no PC may receive pushes any more. */
    @Synchronized
    fun clearAll(c: Context) {
        prefs(c).edit().remove(KEY_SUBS).apply()
    }

    fun subscriptions(c: Context): List<PushSubscriptionData> {
        val arr = readRaw(c)
        val out = ArrayList<PushSubscriptionData>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            out.add(
                PushSubscriptionData(
                    o.optString("token"), o.optString("endpoint"),
                    o.optString("p256dh"), o.optString("auth"),
                )
            )
        }
        return out
    }

    private fun readRaw(c: Context): JSONArray =
        runCatching { JSONArray(prefs(c).getString(KEY_SUBS, "[]")) }.getOrDefault(JSONArray())
}

/**
 * RFC 8030 Web Push sender with RFC 8291 (aes128gcm payload encryption) and
 * RFC 8292 (VAPID) implemented on the Android platform crypto providers.
 *
 * The current nl.martijndwars/web-push line (6.x, dev.blanke.webpush) is built
 * on java.net.http and a pluggable JWT factory, neither of which is available
 * in the Android runtime; the older 5.1.2 line drags in desktop Apache
 * HttpClient and a signed desktop BouncyCastle provider, which collide with
 * Android's bootclasspath copies. The platform implementation below needs no
 * extra dependency and is verified against the RFC 8291 worked example.
 */
object WebPushSender {
    private const val SUBJECT = "https://tsunagu-link.vercel.app"
    private const val TTL_SECONDS = 3600
    private const val MAX_PAYLOAD_BYTES = 3000

    fun sendToAll(c: Context, item: JSONObject) {
        val subs = WebPushStore.subscriptions(c)
        if (subs.isEmpty()) return
        val payload = payloadFor(item)
        for (sub in subs) {
            val status = runCatching { send(c, sub, payload) }.getOrDefault(-1)
            if (status == 404 || status == 410) {
                // The push service says this subscription is gone for good.
                WebPushStore.removeSubscription(c, sub.token, sub.endpoint)
            }
        }
    }

    private fun payloadFor(item: JSONObject): String {
        val actions = JSONArray()
        item.optJSONArray("actions")?.let { src ->
            for (i in 0 until minOf(src.length(), 2)) actions.put(truncate(src.optString(i), 32))
        }
        var text = item.optString("text")
        fun build(): String = JSONObject()
            .put("push", true)
            .put("app", truncate(item.optString("app"), 80))
            .put("pkg", item.optString("pkg"))
            .put("title", truncate(item.optString("title"), 160))
            .put("text", text)
            .put("key", item.optString("key"))
            .put("time", item.optLong("time"))
            .put("reply", item.optBoolean("reply"))
            .put("actions", actions)
            .toString()
        var out = build()
        // Push services accept at most ~4 KB after encryption overhead; keep a
        // safety margin by trimming the body text, never the identifiers.
        while (out.toByteArray(Charsets.UTF_8).size > MAX_PAYLOAD_BYTES && text.isNotEmpty()) {
            text = text.dropLast(minOf(100, text.length))
            out = build()
        }
        return out
    }

    private fun truncate(s: String, max: Int) = if (s.length <= max) s else s.substring(0, max)

    private fun send(c: Context, sub: PushSubscriptionData, payload: String): Int {
        val (publicKey, privateKey) = WebPushStore.keyPair(c)
        val body = encrypt(sub.p256dh, sub.auth, payload.toByteArray(Charsets.UTF_8))
        val jwt = vapidJwt(sub.endpoint, privateKey, publicKey)
        val conn = (URL(sub.endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 15_000
            doOutput = true
            setRequestProperty("Content-Encoding", "aes128gcm")
            setRequestProperty("Content-Type", "application/octet-stream")
            setRequestProperty("Content-Length", body.size.toString())
            setRequestProperty("TTL", TTL_SECONDS.toString())
            setRequestProperty("Urgency", "high")
            setRequestProperty("Authorization", "vapid t=$jwt, k=$publicKey")
        }
        try {
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            runCatching { (if (code >= 400) conn.errorStream else conn.inputStream)?.readBytes() }
            return code
        } finally {
            conn.disconnect()
        }
    }

    // ---------------- VAPID (RFC 8292) ----------------
    private fun vapidJwt(endpoint: String, privateB64: String, publicB64: String): String {
        val url = URL(endpoint)
        val aud = buildString {
            append(url.protocol).append("://").append(url.host)
            if (url.port != -1) append(':').append(url.port)
        }
        val header = JSONObject().put("typ", "JWT").put("alg", "ES256").toString()
        val claims = JSONObject()
            .put("aud", aud)
            .put("exp", System.currentTimeMillis() / 1000 + 12 * 3600)
            .put("sub", SUBJECT)
            .toString()
        val signingInput = b64Encode(header.toByteArray(Charsets.UTF_8)) + "." +
            b64Encode(claims.toByteArray(Charsets.UTF_8))
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(privateKeyFromScalar(b64Decode(privateB64)))
        signer.update(signingInput.toByteArray(Charsets.UTF_8))
        return signingInput + "." + b64Encode(derToJose(signer.sign()))
    }

    // ---------------- Payload encryption (RFC 8291, aes128gcm) ----------------
    private fun encrypt(uaPublicB64: String, authB64: String, payload: ByteArray): ByteArray {
        val uaPublicBytes = b64Decode(uaPublicB64)
        val uaPublic = publicKeyFromBytes(uaPublicBytes)
        val authSecret = b64Decode(authB64)

        val gen = KeyPairGenerator.getInstance("EC")
        gen.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())
        val ephemeral = gen.generateKeyPair()
        val asPublicBytes = publicKeyBytes(ephemeral.public as ECPublicKey)

        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(ephemeral.private)
        agreement.doPhase(uaPublic, true)
        val ecdhSecret = fixed32(agreement.generateSecret())

        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        // HKDF with HMAC-SHA-256 (RFC 5869), one expand block is enough for
        // every output length used here (<= 32 bytes).
        val prkKey = hmac(authSecret, ecdhSecret)
        val keyInfo = "WebPush: info".toByteArray(Charsets.UTF_8) + byteArrayOf(0) + uaPublicBytes + asPublicBytes
        val ikm = hmac(prkKey, keyInfo + byteArrayOf(1))
        val prk = hmac(salt, ikm)
        val cek = hmac(prk, "Content-Encoding: aes128gcm".toByteArray(Charsets.UTF_8) + byteArrayOf(0, 1)).copyOf(16)
        val nonce = hmac(prk, "Content-Encoding: nonce".toByteArray(Charsets.UTF_8) + byteArrayOf(0, 1)).copyOf(12)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
        val ciphertext = cipher.doFinal(payload + byteArrayOf(2))

        val out = ByteBuffer.allocate(16 + 4 + 1 + asPublicBytes.size + ciphertext.size)
        out.put(salt)
        out.putInt(4096)
        out.put(asPublicBytes.size.toByte())
        out.put(asPublicBytes)
        out.put(ciphertext)
        return out.array()
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    // ---------------- EC helpers ----------------
    private fun ecParams(): ECParameterSpec {
        val params = AlgorithmParameters.getInstance("EC")
        params.init(ECGenParameterSpec("secp256r1"))
        return params.getParameterSpec(ECParameterSpec::class.java)
    }

    private fun publicKeyFromBytes(bytes: ByteArray): ECPublicKey {
        require(bytes.size == 65 && bytes[0].toInt() == 4) { "not an uncompressed P-256 point" }
        val x = BigInteger(1, bytes.copyOfRange(1, 33))
        val y = BigInteger(1, bytes.copyOfRange(33, 65))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), ecParams())) as ECPublicKey
    }

    private fun privateKeyFromScalar(scalar: ByteArray): ECPrivateKey =
        KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, scalar), ecParams())) as ECPrivateKey

    private fun derToJose(der: ByteArray): ByteArray {
        var offset = 0
        fun readByte(): Int = der[offset++].toInt() and 0xFF
        require(readByte() == 0x30) { "bad DER signature" }
        var len = readByte()
        if (len and 0x80 != 0) {
            val n = len and 0x7F
            len = 0
            repeat(n) { len = (len shl 8) or readByte() }
        }
        fun readInt(): ByteArray {
            require(readByte() == 0x02) { "bad DER integer" }
            val l = readByte()
            val raw = der.copyOfRange(offset, offset + l)
            offset += l
            return fixed32(raw)
        }
        return readInt() + readInt()
    }

}

// EC encoding helpers shared by the store and the sender.
fun publicKeyBytes(key: ECPublicKey): ByteArray {
    val out = ByteArray(65)
    out[0] = 4
    fixed32(key.w.affineX.toByteArray()).copyInto(out, 1)
    fixed32(key.w.affineY.toByteArray()).copyInto(out, 33)
    return out
}

/** Big-endian value as exactly 32 bytes (drops a sign zero, left-pads). */
fun fixed32(bytes: ByteArray): ByteArray = when {
    bytes.size == 32 -> bytes
    bytes.size > 32 -> bytes.copyOfRange(bytes.size - 32, bytes.size)
    else -> ByteArray(32 - bytes.size) + bytes
}

// Base64URL helpers shared by the store and the sender.
fun b64Encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

fun b64Decode(s: String): ByteArray = Base64.getUrlDecoder().decode(s)
