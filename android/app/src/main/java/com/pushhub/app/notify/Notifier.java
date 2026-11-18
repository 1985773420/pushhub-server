package com.pushhub.app.notify;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.pushhub.app.App;
import com.pushhub.app.ImageLoader;
import com.pushhub.app.MainActivity;
import com.pushhub.app.MessageDetailActivity;
import com.pushhub.app.R;
import com.pushhub.app.msg.Attachment;
import com.pushhub.app.msg.MessageItem;
import com.pushhub.app.prefs.AppPrefs;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 通知渠道与单条消息通知。每个来源一个渠道，用户可在系统设置里单独调。 */
public final class Notifier {
    public static final String CONN_CHANNEL = "conn";

    private static final java.util.Map<String, Long> RECENT = new java.util.HashMap<>();
    private static final ExecutorService IMAGE_POOL = Executors.newFixedThreadPool(2);

    /** Serialized with unpairing: an old receiver cannot refill cleared history. */
    public static synchronized void receive(Context ctx, java.util.List<MessageItem> items, boolean offline) {
        if (!AppPrefs.get(ctx).isPaired()) return;
        java.util.List<MessageItem> fresh = com.pushhub.app.msg.MessageStore.receive(items);
        java.util.List<MessageItem> visible = new java.util.ArrayList<>();
        AppPrefs prefs = AppPrefs.get(ctx);
        for (MessageItem m : fresh) {
            if (!prefs.mutedSources().contains(m.source) && !prefs.isQuiet(m.source)) visible.add(m);
        }
        if (offline) {
            if (!visible.isEmpty()) showSummary(ctx, visible);
        } else {
            for (MessageItem m : visible) {
                show(ctx, m);
                LiveUpdate.onMessage(ctx, m);
            }
        }
    }

    public static synchronized void clear(Context ctx) {
        com.pushhub.app.msg.MessageStore.clear();
        RECENT.clear();
        nm(ctx).cancelAll();
    }

    private static void showSummary(Context ctx, java.util.List<MessageItem> items) {
        String channel = "offline_summary";
        NotificationChannel ch = new NotificationChannel(channel, "离线消息汇总", NotificationManager.IMPORTANCE_DEFAULT);
        nm(ctx).createNotificationChannel(ch);
        NotificationCompat.InboxStyle style = new NotificationCompat.InboxStyle();
        java.util.Set<String> sources = new java.util.HashSet<>();
        for (MessageItem m : items) {
            sources.add(m.source);
        }
        for (int i = Math.max(0, items.size() - 5); i < items.size(); i++) {
            MessageItem m = items.get(i);
            style.addLine(clip(App.sourceName(m.source) + " · " + (m.title == null || m.title.isEmpty() ? m.body : m.title), 160));
        }
        PendingIntent pi = PendingIntent.getActivity(ctx, 1002,
                new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, channel)
                .setSmallIcon(R.drawable.ic_notify).setContentTitle("收到 " + items.size() + " 条离线消息")
                .setContentText(sources.size() + " 个来源 · 点开查看全部历史")
                .setStyle(style).setContentIntent(pi).setAutoCancel(true).setOnlyAlertOnce(true);
        if (AppPrefs.get(ctx).silentMode()) b.setSilent(true);
        try { nm(ctx).notify("offline", 1, b.build()); } catch (SecurityException ignored) {}
    }

    private Notifier() {
    }

    public static void ensureConnChannel(Context ctx) {
        NotificationChannel ch = new NotificationChannel(CONN_CHANNEL,
                ctx.getString(R.string.conn_channel), NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        nm(ctx).createNotificationChannel(ch);
    }

    /** 来源渠道 id。 */
    public static String channelFor(String sourceId) {
        return "src_" + sourceId;
    }

    private static int importanceFor(String priority, boolean silent) {
        if (silent) return NotificationManager.IMPORTANCE_LOW;
        if ("high".equals(priority)) return NotificationManager.IMPORTANCE_HIGH;
        if ("low".equals(priority)) return NotificationManager.IMPORTANCE_LOW;
        return NotificationManager.IMPORTANCE_DEFAULT;
    }

    public static void ensureSourceChannel(Context ctx, String sourceId, String name, String priority, boolean silent) {
        NotificationChannel ch = new NotificationChannel(channelFor(sourceId),
                name + " · " + ctx.getString(R.string.notification_channel_suffix),
                importanceFor(priority, silent));
        ch.setShowBadge(true);
        ch.enableVibration(!silent);
        ch.setLightColor(Color.parseColor("#5B8DEF"));
        nm(ctx).createNotificationChannel(ch);
    }

    /** 静音开关切换时，把已存在的来源渠道整体调重要性。 */
    public static void applySilent(Context ctx, boolean silent) {
        NotificationManager m = nm(ctx);
        for (NotificationChannel ch : m.getNotificationChannels()) {
            if (!ch.getId().startsWith("src_")) continue;
            ch.setImportance(importanceFor("normal", silent));
            ch.enableVibration(!silent);
            m.createNotificationChannel(ch);
        }
    }

    public static void show(Context ctx, MessageItem msg) {
        AppPrefs prefs = AppPrefs.get(ctx);
        if (prefs.mutedSources().contains(msg.source) || prefs.isQuiet(msg.source)) return;
        long now = android.os.SystemClock.elapsedRealtime();
        String fingerprint = msg.source + "\n" + msg.title + "\n" + msg.body + "\n" + msg.url;
        Long previous = RECENT.put(fingerprint, now);
        boolean coalesced = previous != null && now - previous < 60_000;
        RECENT.entrySet().removeIf(e -> now - e.getValue() >= 60_000);

        App.SourceInfo info = App.sourceInfo(msg.source);
        String name = info == null ? App.sourceName(msg.source) : info.name;
        String priority = msg.priority;
        if (!"high".equals(priority) && !"low".equals(priority) && !"normal".equals(priority)) {
            priority = info == null ? "normal" : info.priority;
        }
        // Android locks channel importance after creation; use one channel per priority.
        String deliverySource = msg.source + "_priority_" + priority;
        ensureSourceChannel(ctx, deliverySource, name, priority, prefs.silentMode());

        // 点通知直接进完整消息页；只传 id 与小字段，正文由详情页按需加载，避免大字符串走 Binder。
        Intent open = MessageDetailActivity.intentFor(ctx, msg)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, notifIdFor(msg), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String body = msg.body == null ? "" : msg.body;
        String notifText = clip(body, 4000);
        int attachCount = msg.attachments == null ? 0 : msg.attachments.size();
        String subText = attachCount > 0
                ? name + " · " + ctx.getString(R.string.attachment_count, attachCount)
                : name;
        String channel = channelFor(deliverySource);
        NotificationCompat.Builder b = baseBuilder(ctx, msg, name, priority, pi, channel, notifText, subText);
        b.setStyle(new NotificationCompat.BigTextStyle().bigText(notifText));

        if ("high".equals(priority)) {
            b.setDefaults(NotificationCompat.DEFAULT_ALL);
        }
        boolean silent = prefs.silentMode() || coalesced;
        if (silent) {
            b.setSilent(true).setDefaults(0);
        }

        int notifId = notifIdFor(msg);
        String tag = "message:" + fingerprint;
        // Identical content within a minute updates one card without alerting again.
        try { nm(ctx).notify(tag, notifId, b.setOnlyAlertOnce(coalesced).build()); }
        catch (SecurityException ignored) {}

        // 有图片附件时，先在后台下载一张缩略图，再用同一 tag 静默更新为大图通知。
        Attachment cover = firstImage(msg);
        if (cover != null) {
            final Context app = ctx.getApplicationContext();
            final String coverUrl = cover.absoluteUrl(prefs.serverUrl());
            final String finalTag = tag;
            final String finalNotifText = notifText;
            final String finalSubText = subText;
            final MessageItem finalMsg = msg;
            final String finalName = name;
            final String finalPriority = priority;
            final PendingIntent finalPi = pi;
            final String finalChannel = channel;
            IMAGE_POOL.execute(() -> {
                Bitmap bm = ImageLoader.loadSync(coverUrl, 512);
                if (bm == null) return;
                NotificationCompat.Builder nb = baseBuilder(app, finalMsg, finalName, finalPriority, finalPi, finalChannel, finalNotifText, finalSubText)
                        .setStyle(new NotificationCompat.BigPictureStyle()
                                .bigPicture(bm)
                                .setBigContentTitle(finalMsg.title == null || finalMsg.title.isEmpty() ? finalName : finalMsg.title)
                                .setSummaryText(finalSubText))
                        .setOnlyAlertOnce(true)
                        .setSilent(true)
                        .setDefaults(0);
                try { nm(app).notify(finalTag, notifId, nb.build()); } catch (SecurityException ignored) {}
            });
        }
    }

    private static NotificationCompat.Builder baseBuilder(Context ctx, MessageItem msg, String name, String priority,
                                                          PendingIntent pi, String channel, String notifText, String subText) {
        return new NotificationCompat.Builder(ctx, channel)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(msg.title == null || msg.title.isEmpty() ? name : msg.title)
                .setContentText(clip(msg.body == null ? "" : msg.body, 200))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(notifText))
                .setSubText(subText)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setWhen(msg.ts)
                .setShowWhen(true)
                .setPriority("high".equals(priority) ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setColor(Color.parseColor("#1D4ED8"));
    }

    private static Attachment firstImage(MessageItem msg) {
        if (msg.attachments == null) return null;
        for (Attachment a : msg.attachments) {
            if (a.isImage() && a.url != null && !a.url.isEmpty()) return a;
        }
        return null;
    }

    private static String clip(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…\n（完整内容请点开通知查看）";
    }

    private static int notifIdFor(MessageItem m) {
        int h = 17;
        h = h * 31 + (m.source == null ? 0 : m.source.hashCode());
        h = h * 31 + (m.id == null ? 0 : m.id.hashCode());
        return h & 0x7FFFFFFF;
    }

    private static NotificationManager nm(Context ctx) {
        return (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    }
}