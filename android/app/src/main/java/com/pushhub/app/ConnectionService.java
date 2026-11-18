package com.pushhub.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.pushhub.app.msg.MessageItem;
import com.pushhub.app.msg.MessageStore;
import com.pushhub.app.notify.LiveUpdate;
import com.pushhub.app.notify.Notifier;
import com.pushhub.app.prefs.AppPrefs;
import com.pushhub.app.ws.WsClient;

import org.json.JSONObject;

/**
 * 前台服务：维持一条到服务端的 WebSocket，收到消息就发本地通知。
 * 断线自动重连（1s→30s 退避）；服务被系统杀掉后靠 START_STICKY + 开机广播尽量拉起。
 */
public class ConnectionService extends Service implements WsClient.Callback {
    public static final String ACTION_START = "com.pushhub.START";
    public static final String ACTION_STOP = "com.pushhub.STOP";

    private static final int CONN_NOTIF_ID = 1001;
    private static final long IDLE_TIMEOUT_MS = 90_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WsClient client;
    private boolean shouldRun;
    private static volatile boolean running;
    private boolean foregroundStarted;
    private int failures;
    private long connectedAt;

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, ConnectionService.class).setAction(ACTION_START);
        try {
            ContextCompat.startForegroundService(ctx, i);
        } catch (Exception ignored) {
        }
    }

    public static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, ConnectionService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        Notifier.ensureConnChannel(this);
        ServiceWatchdog.schedule(this);
    }

    /** 进程内服务是否还活着（看护接收器据此决定是否补拉）。 */
    public static boolean isRunning() {
        return running;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ServiceWatchdog.schedule(this);
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            shouldRun = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        ensureForeground(false);
        if (!AppPrefs.get(this).isPaired()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!shouldRun) {
            shouldRun = true;
            connect();
        }
        return START_STICKY;
    }

    private final Runnable receiptRetry = new Runnable() { public void run() { Receipts.flush(ConnectionService.this); if (shouldRun) handler.postDelayed(this, 30000); } };

    private void connect() {
        if (!shouldRun) return;
        AppPrefs prefs = AppPrefs.get(this);
        if (prefs.paused()) {
            App.setStatus(App.Status.PAUSED);
            return;
        }
        String url = prefs.wsUrl();
        App.setStatus(App.Status.CONNECTING);
        WsClient old = client;
        if (old != null) old.close(1000, "reconnect");
        client = new WsClient(url, this, (int) IDLE_TIMEOUT_MS);
        App.setClient(client);
        diagnostic("attempt", "");
        client.connect();
    }

    // ---------------------------------------------------------------- WsClient.Callback

    @Override
    public void onOpen(WsClient c) {
        diagnostic("connected", "");
        Receipts.flush(this);
        failures = 0;
        connectedAt = SystemClock.elapsedRealtime();
        App.setStatus(App.Status.CONNECTED);
        handler.post(() -> ensureForeground(true));
    }

    @Override
    public void onMessage(WsClient c, String text) {
        try {
            if (c != client || !AppPrefs.get(this).isPaired()) return;
            JSONObject root = new JSONObject(text);
            String type = root.optString("type");
            switch (type) {
                case "hello": {
                    App.storeHello(root);
                    App.setStatus(App.Status.CONNECTED);
                    // 离线期间排队的消息：补发通知，然后 ack 清空服务端队列。
                    org.json.JSONArray pend = root.optJSONArray("pending");
                    if (pend != null && pend.length() > 0) {
                        java.util.List<MessageItem> batch = new java.util.ArrayList<>();
                        org.json.JSONArray ids = new org.json.JSONArray();
                        for (int i = 0; i < pend.length(); i++) {
                            JSONObject o = pend.optJSONObject(i);
                            if (o == null) continue;
                            MessageItem pm = MessageItem.fromJson(o);
                            batch.add(pm);
                            if (pm.id != null && !pm.id.isEmpty()) ids.put(pm.id);
                        }
                        Notifier.receive(this, batch, true);
                        for (MessageItem pm : batch) Receipts.enqueue(this, pm.id, "received");
                        if (ids.length() > 0) c.sendText("{\"type\":\"ack\",\"ids\":" + ids + "}");
                    }
                    Receipts.flush(this);
                    handler.removeCallbacks(receiptRetry);
                    handler.postDelayed(receiptRetry, 30000);
                    HistorySync.run(this);
                    handler.post(this::updateForegroundText);
                    break;
                }
                case "msg": {
                    JSONObject o = root.optJSONObject("msg");
                    if (o == null) break;
                    MessageItem m = MessageItem.fromJson(o);
                    Notifier.receive(this, java.util.Collections.singletonList(m), false);
                    Receipts.enqueue(this, m.id, "received");
                    c.sendText(new JSONObject().put("type", "ack").put("id", m.id).toString());
                    break;
                }
                case "replaced": {
                    App.setStatus(App.Status.REPLACED);
                    shouldRun = false;
                    handler.post(() -> updateForegroundText());
                    break;
                }
                case "error": {
                    if ("unauthorized".equals(root.optString("error"))) {
                        App.setStatus(App.Status.UNAUTHORIZED);
                        shouldRun = false;
                    }
                    break;
                }
                default:
                    break;
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onClose(WsClient c, int code, String reason) {
        if (c != client) return; // 旧连接的回调，忽略
        diagnostic("disconnected", "code=" + code);
        if (!shouldRun) return;
        if (code == 4401) {
            App.setStatus(App.Status.UNAUTHORIZED);
            shouldRun = false;
            handler.post(() -> updateForegroundText());
            return;
        }
        if (code == 4001) {
            // 同一 token 的另一端把这条连接顶掉了：不要立刻重连，否则会互相踢。
            App.setStatus(App.Status.REPLACED);
            shouldRun = false;
            handler.post(() -> updateForegroundText());
            return;
        }
        // 连接存活超过 60s 视为稳定，重新计数退避
        if (connectedAt > 0 && SystemClock.elapsedRealtime() - connectedAt > 60_000) failures = 0;
        long aliveMs = connectedAt > 0 ? SystemClock.elapsedRealtime() - connectedAt : 0;
        if (aliveMs > 0 && aliveMs < 60_000) failures++;
        int[] steps = {1, 2, 4, 8, 15, 30};
        int delay = steps[Math.min(failures, steps.length - 1)];
        App.setStatus(App.Status.OFFLINE, delay);
        handler.post(this::updateForegroundText);
        handler.postDelayed(this::connect, delay * 1000L);
    }

    @Override
    public void onError(WsClient c, Exception e) {
        diagnostic("error", e.getClass().getSimpleName());
    }

    private void diagnostic(String key, String detail) {
        getSharedPreferences("diagnostics", 0).edit().putString(key, new java.util.Date().toString() + " " + detail).apply();
    }

    // ---------------------------------------------------------------- 前台通知

    private void ensureForeground(boolean connected) {
        Notification n = buildConnNotification(connected);
        try {
            if (!foregroundStarted) {
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(CONN_NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                } else {
                    startForeground(CONN_NOTIF_ID, n);
                }
                foregroundStarted = true;
            } else {
                ((android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(CONN_NOTIF_ID, n);
            }
        } catch (Exception ignored) {
        }
    }

    private void updateForegroundText() {
        ensureForeground(App.status() == App.Status.CONNECTED);
    }

    private Notification buildConnNotification(boolean connected) {
        Intent open = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String text;
        App.Status st = App.status();
        if (st == App.Status.REPLACED) {
            text = getString(R.string.status_replaced);
        } else if (st == App.Status.UNAUTHORIZED) {
            text = getString(R.string.status_unauthorized);
        } else if (st == App.Status.PAUSED) {
            text = getString(R.string.status_paused);
        } else if (connected) {
            text = getString(R.string.conn_text, AppPrefs.get(this).baseForDisplay());
        } else if (st == App.Status.OFFLINE) {
            text = getString(R.string.conn_reconnecting);
        } else {
            text = getString(R.string.status_connecting);
        }

        return new NotificationCompat.Builder(this, Notifier.CONN_CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(getString(R.string.conn_title))
                .setContentText(text)
                .setContentIntent(pi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }

    // ---------------------------------------------------------------- lifecycle

    @Override
    public void onDestroy() {
        running = false;
        shouldRun = false;
        handler.removeCallbacksAndMessages(null);
        if (client != null) client.close(1000, "service stop");
        App.setClient(null);
        App.setStatus(App.Status.PAUSED);
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 从最近任务划掉后仍要收消息：重启自己
        if (AppPrefs.get(this).isPaired() && !AppPrefs.get(this).paused()) {
            start(this);
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}