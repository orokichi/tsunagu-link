package com.orokichi.tsunagu

import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * File-explorer backend （エクスプローラー）: browses the shared storage via
 * plain java.io.File. Full access requires the user to grant "すべてのファイル
 * へのアクセス" (MANAGE_EXTERNAL_STORAGE) in system settings; without it,
 * scoped storage hides most folders and listings simply come back partial or
 * empty — the `access` flag in every reply tells the PC which state we are in.
 *
 * All paths crossing the wire are relative to the storage root. resolve()
 * canonicalises and refuses anything that escapes the root (path traversal),
 * and validateName() keeps rename/mkdir/upload targets inside their folder.
 */
object Explorer {
    fun root(): File = Environment.getExternalStorageDirectory()
    fun hasAccess(): Boolean = Environment.isExternalStorageManager()

    /** Resolves a root-relative path, or null if it escapes the storage root. */
    fun resolve(rel: String): File? {
        val r = runCatching { root().canonicalFile }.getOrNull() ?: return null
        val f = runCatching { if (rel.isBlank()) r else File(r, rel).canonicalFile }.getOrNull() ?: return null
        return if (f.path == r.path || f.path.startsWith(r.path + File.separator)) f else null
    }

    /** Root-relative path of a file already known to be inside the root. */
    fun relOf(f: File): String {
        val r = runCatching { root().canonicalFile }.getOrNull() ?: return ""
        val c = runCatching { f.canonicalFile }.getOrNull() ?: return ""
        return if (c.path == r.path) "" else c.path.removePrefix(r.path + File.separator)
    }

    /** A single path segment from the user: no separators, no dot tricks. */
    fun validateName(name: String): Boolean =
        name.isNotBlank() && name.length <= 120 && name != "." && name != ".." &&
            !name.contains('/') && !name.contains('\\') && !name.contains('\u0000')

    fun list(rel: String): JSONObject {
        val out = JSONObject().put("access", hasAccess())
        val dir = resolve(rel) ?: return out.put("error", "path").put("path", "").put("items", JSONArray())
        val items = JSONArray()
        val children = runCatching { dir.listFiles() }.getOrNull()
        if (children == null) {
            return out.put("path", relOf(dir)).put("items", items)
                .put("error", if (dir.exists()) "unreadable" else "missing")
        }
        children.sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase() })).forEach { f ->
            items.put(JSONObject().put("name", f.name).put("dir", f.isDirectory)
                .put("size", if (f.isDirectory) 0 else runCatching { f.length() }.getOrDefault(0))
                .put("time", runCatching { f.lastModified() }.getOrDefault(0)))
        }
        return out.put("path", relOf(dir)).put("items", items)
    }

    fun delete(rel: String): Boolean {
        if (rel.isBlank()) return false // never delete the root itself
        val f = resolve(rel) ?: return false
        if (!f.exists()) return false
        return runCatching { f.deleteRecursively() }.getOrDefault(false)
    }

    fun rename(rel: String, newName: String): Boolean {
        if (!validateName(newName)) return false
        val f = resolve(rel) ?: return false
        val parent = f.parentFile ?: return false
        val target = File(parent, newName)
        if (target.exists()) return false
        return runCatching { f.renameTo(target) }.getOrDefault(false)
    }

    fun mkdir(dirRel: String, name: String): Boolean {
        if (!validateName(name)) return false
        val dir = resolve(dirRel) ?: return false
        val target = File(dir, name)
        if (target.exists()) return false
        return runCatching { target.mkdirs() }.getOrDefault(false)
    }

    /** Target file for an upload into dirRel; null on bad name / traversal. */
    fun uploadTarget(dirRel: String, name: String): File? {
        if (!validateName(name)) return null
        val dir = resolve(dirRel) ?: return null
        if (!dir.isDirectory) return null
        val f = File(dir, name)
        // validateName already forbids separators; double-check containment anyway.
        val r = runCatching { root().canonicalFile }.getOrNull() ?: return null
        val c = runCatching { f.canonicalFile }.getOrNull() ?: return null
        return if (c.path.startsWith(r.path + File.separator)) f else null
    }

    fun mimeOf(f: File): String =
        android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream"
}
