package com.pushhub.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.util.Log;

import com.pushhub.app.prefs.AppPrefs;

/**
 * 闹钟看护的接收器：服务还活着就什么都不做；进程被杀就尝试拉起前台服务
 * （精确闹钟属于 Android 12+ 的后台启动豁免），拉不起来就短连接补拉队列。
 */
public class WatchdogReceiver extends BroadcastReceiver {
    private static final String TAG = "PushHub.Watchdog";

    @Override
    public void onReceive(Context context, Intent intent) {
        // 先排下一次，再干活，避免异常导致看护停摆。
        ServiceWatchdog.schedule(context);

        AppPrefs prefs = AppPrefs.get(context);
        if (!prefs.isPaired() || prefs.paused()) return;

        final PendingResult pr = goAsync();
        final Context ctx = context.getApplicationContext();
        new Thread(() -> {
            try {
                if (ConnectionService.isRunning()) {
                    Log.i(TAG, "service alive, nothing to do");
                    return;
                }
                boolean started = false;
                try {
                    ConnectionService.start(ctx);
                    // 等几秒看是否真的连上；连接失败说明后台启动被系统拦了。
                    long t0 = SystemClock.elapsedRealtime();
                    while (SystemClock.elapsedRealtime() - t0 < 6000) {
                        if (App.status() == App.Status.CONNECTED) {
                            started = true;
                            break;
                        }
                        Thread.sleep(200);
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "start service from watchdog failed", t);
                }
                if (!started) {
                    Log.i(TAG, "falling back to catch-up");
                    CatchUp.runOnce(ctx);
                }
            } catch (Throwable t) {
                Log.w(TAG, "watchdog error", t);
            } finally {
                pr.finish();
            }
        }, "pushhub-watchdog").start();
    }
}