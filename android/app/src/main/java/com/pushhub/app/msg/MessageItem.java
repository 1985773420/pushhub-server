package com.pushhub.app.msg;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** 服务端下发的标准消息。 */
public final class MessageItem {
    public final String id;
    public final String source;
    public final String title;
    public final String body;
    public final String url;
    public final long ts;
    public final String priority;
    public final List<Attachment> attachments;

    public MessageItem(String id, String source, String title, String body, String url, long ts) {
        this(id, source, title, body, url, ts, "normal", Collections.emptyList());
    }

    public MessageItem(String id, String source, String title, String body, String url, long ts, String priority) {
        this(id, source, title, body, url, ts, priority, Collections.emptyList());
    }

    public MessageItem(String id, String source, String title, String body, String url, long ts,
                       String priority, List<Attachment> attachments) {
        this.id = id;
        this.source = source;
        this.title = title;
        this.body = body;
        this.url = url;
        this.ts = ts;
        this.priority = priority == null ? "normal" : priority;
        this.attachments = attachments == null
                ? Collections.emptyList()
                : Collections.unmodifiableList(new ArrayList<>(attachments));
    }

    public static MessageItem fromJson(JSONObject o) {
        String id = o.optString("id", "");
        String source = o.optString("source", "?");
        String title = o.optString("title", "");
        String body = o.optString("body", "");
        String url = o.optString("url", "");
        long ts = System.currentTimeMillis();
        String t = o.optString("ts", "");
        if (!t.isEmpty()) {
            try {
                ts = OffsetDateTime.parse(t).toInstant().toEpochMilli();
            } catch (DateTimeParseException e) {
                try {
                    ts = Instant.parse(t).toEpochMilli();
                } catch (Exception ignored) {
                }
            }
        }
        List<Attachment> attachments = parseAttachments(o.optJSONArray("attachments"));
        if (attachments.isEmpty()) {
            // 兼容只带 image 字段的旧消息/旧接入方。
            String image = o.optString("image", "");
            if (!image.isEmpty()) attachments = Collections.singletonList(
                    new Attachment("", image, "图片", "", "image", 0));
        }
        return new MessageItem(id, source, title, body, url, ts, o.optString("priority", "normal"), attachments);
    }

    public static List<Attachment> parseAttachments(JSONArray arr) {
        if (arr == null || arr.length() == 0) return Collections.emptyList();
        List<Attachment> out = new ArrayList<>();
        for (int i = 0; i < arr.length() && out.size() < 20; i++) {
            Attachment a = Attachment.fromJson(arr.optJSONObject(i));
            if (a != null) out.add(a);
        }
        return out;
    }

    public static List<Attachment> parseStored(String json) {
        if (json == null || json.isEmpty()) return Collections.emptyList();
        try {
            return parseAttachments(new JSONArray(json));
        } catch (Exception e) {
            return Collections.emptyList();
        }
    }

    public String attachmentsJson() {
        JSONArray arr = new JSONArray();
        for (Attachment a : attachments) arr.put(a.toJson());
        return arr.toString();
    }
}