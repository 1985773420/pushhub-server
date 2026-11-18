package com.pushhub.app.msg;

import org.json.JSONException;
import org.json.JSONObject;

/** 消息附件：图片、视频或文档。URL 可能是服务端的相对路径（/media/…）。 */
public final class Attachment {
    public final String id;
    public final String url;
    public final String name;
    public final String mime;
    public final String type;
    public final long size;

    public Attachment(String id, String url, String name, String mime, String type, long size) {
        this.id = id == null ? "" : id;
        this.url = url == null ? "" : url;
        this.name = name == null || name.isEmpty() ? "附件" : name;
        this.mime = mime == null ? "" : mime;
        this.type = type == null ? "" : type;
        this.size = size;
    }

    public static Attachment fromJson(JSONObject o) {
        if (o == null) return null;
        String url = o.optString("url", "");
        if (url.isEmpty()) url = o.optString("src", "");
        if (url.isEmpty()) return null;
        String name = o.optString("name", "");
        if (name.isEmpty()) name = o.optString("filename", "");
        String mime = o.optString("mime", "");
        String type = o.optString("type", "");
        if (!"image".equals(type) && !"video".equals(type) && !"file".equals(type)) {
            type = guessType(mime, name, url);
        }
        return new Attachment(o.optString("id", ""), url, name, mime, type, o.optLong("size", 0));
    }

    private static String guessType(String mime, String name, String url) {
        String m = mime == null ? "" : mime.toLowerCase();
        if (m.startsWith("image/")) return "image";
        if (m.startsWith("video/")) return "video";
        String n = (name == null ? "" : name).toLowerCase();
        if (n.isEmpty()) n = url == null ? "" : url.toLowerCase();
        if (n.matches(".*\\.(png|jpe?g|gif|webp|bmp|heic)(\\?.*)?$")) return "image";
        if (n.matches(".*\\.(mp4|webm|mov|m4v|mkv)(\\?.*)?$")) return "video";
        return "file";
    }

    public boolean isImage() {
        return "image".equals(type);
    }

    public boolean isVideo() {
        return "video".equals(type);
    }

    /** 把服务端相对路径补成手机可访问的绝对地址。 */
    public String absoluteUrl(String base) {
        if (url.startsWith("http://") || url.startsWith("https://")) return url;
        if (url.startsWith("/")) {
            String b = base == null ? "" : base;
            while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
            return b + url;
        }
        return url;
    }

    public String displaySize() {
        if (size <= 0) return "";
        if (size < 1024) return size + " B";
        if (size < 1024 * 1024) return String.format(java.util.Locale.getDefault(), "%.1f KB", size / 1024.0);
        return String.format(java.util.Locale.getDefault(), "%.1f MB", size / (1024.0 * 1024.0));
    }

    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            o.put("url", url);
            o.put("name", name);
            o.put("mime", mime);
            o.put("type", type);
            o.put("size", size);
        } catch (JSONException ignored) {
        }
        return o;
    }
}