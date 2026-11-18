package com.pushhub.app.notify;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.pushhub.app.App;
import com.pushhub.app.MainActivity;
import com.pushhub.app.R;
import com.pushhub.app.msg.MessageItem;
import com.pushhub.app.prefs.AppPrefs;

import java.util.ArrayList;
import java.util.List;

/**
 * Android 16 Live Updates（ColorOS 16/17 会自动提升为「流体云」胶囊/卡片）。
 *
 * 官方要求（developer.android.com/develop/ui/compose/notifications/live-update）：
 *  - 必须声明 POST_PROMOTED_NOTIFICATIONS 权限；
 *  - setRequestPromotedOngoing(true) + setShortCriticalText(...)；
 *  - 必须是 ongoing、有 contentTitle、不能是 groupSummary；
 *  - 不能用自定义 RemoteViews、不能 setColorized；
 *  - 渠道 importance 不能是 MIN。
 *
 * 做法：每收到一条消息刷新一张持续的「实况卡」，15 分钟无新消息自动结束。
 * 不支持 Android 16 Live Updates 的机型自动跳过，普通逐条通知仍然照常。
 */
public final class LiveUpdate {
    public static final String CHANNEL = "live";

    private static final int NOTIF_ID = 20565;
    private static final long WINDOW_MS = 15 * 60_000L;
    private static final int MAX_LINES = 3;

    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static final List<String> lines = new ArrayList<>();
    private static final Runnable expire = () -> {
        Context c = App.ctx();
        if (c != null) cancel(c);
    };

    private static int count;
    private static long lastTs;
    private static String latestTitle = "";
    private static String latestBody = "";

    private LiveUpdate() {
    }

    public static void ensureChannel(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        android.app.NotificationChannel ch = new android.app.NotificationChannel(
                CHANNEL,
                "流体云实况通知",
                NotificationManager.IMPORTANCE_HIGH);
        // 逐条消息通知负责响铃/震动，实况卡只负责"持续展示"，避免每次刷新都响。
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.setShowBadge(false);
        ch.setDescription("最近消息会以常驻卡片/流体云胶囊展示");
        nm.createNotificationChannel(ch);
    }

    /** 当前设备/系统是否允许把通知提升为 Live Update。 */
    public static boolean canPromote(Context ctx) {
        if (Build.VERSION.SDK_INT < 36) return false;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || !nm.areNotificationsEnabled()) return false;
        try {
            return nm.canPostPromotedNotifications();
        } catch (Throwable t) {
            return false;
        }
    }

    /** 新消息到达时调用；被静音的来源不再上云。 */
    public static synchronized void onMessage(Context ctx, MessageItem m) {
        if (!AppPrefs.get(ctx).liveUpdates()) return;
        if (m == null) return;
        if (AppPrefs.get(ctx).mutedSources().contains(m.source) || AppPrefs.get(ctx).isQuiet(m.source)) return;
        if (!canPromote(ctx)) return;
        ensureChannel(ctx);

        count++;
        lines.add(0, renderLine(m));
        while (lines.size() > MAX_LINES) lines.remove(lines.size() - 1);
        latestTitle = m.title == null ? "" : m.title;
        latestBody = m.body == null ? "" : m.body;
        lastTs = m.ts > 0 ? m.ts : System.currentTimeMillis();

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(latestTitle.isEmpty() ? "PushHub 新消息" : latestTitle)
                .setContentText(latestBody)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(String.join("\n", lines)))
                .setShortCriticalText(shortText())
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setShowWhen(true)
                .setWhen(lastTs)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setContentIntent(openApp(ctx))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setRequestPromotedOngoing(true);

        NotificationManagerCompat.from(ctx).notify(NOTIF_ID, b.build());

        handler.removeCallbacks(expire);
        handler.postDelayed(expire, WINDOW_MS);
    }

    /** 结束实况卡（关闭开关、用户打开 App、或 15 分钟无消息）。 */
    public static synchronized void cancel(Context ctx) {
        handler.removeCallbacks(expire);
        if (count > 0) {
            try {
                NotificationManagerCompat.from(ctx).cancel(NOTIF_ID);
            } catch (Throwable ignored) {
            }
        }
        count = 0;
        lines.clear();
        latestTitle = "";
        latestBody = "";
        lastTs = 0;
    }

    /** 状态栏胶囊里的短文本，控制在 7 个字符内。 */
    private static String shortText() {
        if (count <= 1) return "新消息";
        if (count > 99) return "99+条";
        return count + "条新消息";
    }

    private static String renderLine(MessageItem m) {
        String source = App.sourceName(m.source);
        String title = m.title == null ? "" : m.title;
        String body = m.body == null ? "" : m.body;
        String line = "【" + source + "】" + (title.isEmpty() ? body : title);
        if (!body.isEmpty() && !title.isEmpty() && !title.equals(body)) line += "：" + body;
        if (line.length() > 120) line = line.substring(0, 119) + "…";
        return line;
    }

    private static PendingIntent openApp(Context ctx) {
        Intent open = new Intent(ctx, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}