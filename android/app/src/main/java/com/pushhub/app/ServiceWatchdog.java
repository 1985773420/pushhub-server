package com.pushhub.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * 闹钟看护：进程被杀后，由系统按时唤醒 WatchdogReceiver 尝试恢复推送。
 * 精确闹钟（用户允许时）能触发 Android 12+ 的后台前台服务启动豁免；否则退化为
 * 非精确闹钟 + 短连接补拉，最坏延迟约十几分钟。
 */
public final class ServiceWatchdog {
    public static final String ACTION = "com.pushhub.WATCHDOG";
    /** 看护间隔：15 分钟是精确闹钟在 Doze 下允许的最小节奏。 */
    public static final long INTERVAL_MS = 15 * 60_000L;

    private ServiceWatchdog() {
    }

    public static PendingIntent intent(Context ctx) {
        Intent i = new Intent(ctx, WatchdogReceiver.class).setAction(ACTION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, 1, i, flags);
    }

    public static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long at = System.currentTimeMillis() + INTERVAL_MS;
        PendingIntent pi = intent(ctx);
        try {
            if (canExact(am)) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    public static void cancel(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(intent(ctx));
    }

    public static boolean canExact(AlarmManager am) {
        if (Build.VERSION.SDK_INT >= 31) return am.canScheduleExactAlarms();
        return true;
    }
}