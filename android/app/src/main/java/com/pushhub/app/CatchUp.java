package com.pushhub.app;

import android.content.Context;
import android.os.SystemClock;
import android.util.Log;

import com.pushhub.app.msg.MessageItem;
import com.pushhub.app.notify.LiveUpdate;
import com.pushhub.app.notify.Notifier;
import com.pushhub.app.prefs.AppPrefs;
import com.pushhub.app.ws.WsClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 「短连接补拉」：进程被系统杀掉、前台服务没能拉起时，由闹钟看护调用。
 * 连一次 WebSocket，收下 hello 里的离线队列 → 发通知 → ack 清空 → 断开，全程 ≤10 秒。
 */
public final class CatchUp {
    private static final String TAG = "PushHub.CatchUp";
    private static final long WAIT_MS = 9000;

    private CatchUp() {
    }

    public static void runOnce(Context ctx) {
        AppPrefs prefs = AppPrefs.get(ctx);
        if (!prefs.isPaired() || prefs.paused() || prefs.token() == null) return;

        final String sessionToken = prefs.token();
        final CountDownLatch done = new CountDownLatch(1);
        final WsClient client = new WsClient(prefs.wsUrl(), new WsClient.Callback() {
            @Override
            public void onOpen(WsClient c) {
            }

            @Override
            public void onMessage(WsClient c, String text) {
                try {
                    if (!sessionToken.equals(prefs.token())) return;
                    JSONObject root = new JSONObject(text);
                    if ("hello".equals(root.optString("type"))) {
                        App.setSourcesFromHello(root);
                        handlePending(ctx, c, root.optJSONArray("pending"));
                        done.countDown();
                    } else if ("msg".equals(root.optString("type"))) {
                        JSONObject o = root.optJSONObject("msg");
                        if (o != null) showMessage(ctx, MessageItem.fromJson(o));
                    }
                } catch (Exception e) {
                    Log.w(TAG, "parse hello failed", e);
                }
            }

            @Override
            public void onClose(WsClient c, int code, String reason) {
                done.countDown();
            }

            @Override
            public void onError(WsClient c, Exception e) {
                done.countDown();
            }
        }, 8000);

        long t0 = SystemClock.elapsedRealtime();
        try {
            client.connect();
            done.await(WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {
        } finally {
            client.close(1000, "catch-up");
        }
        Log.i(TAG, "catch-up finished in " + (SystemClock.elapsedRealtime() - t0) + "ms");
    }

    private static void handlePending(Context ctx, WsClient c, JSONArray pending) {
        if (pending == null || pending.length() == 0) return;
        List<String> ids = new ArrayList<>();
        List<MessageItem> batch = new ArrayList<>();
        for (int i = 0; i < pending.length(); i++) {
            JSONObject o = pending.optJSONObject(i);
            if (o == null) continue;
            MessageItem m = MessageItem.fromJson(o);
            batch.add(m);
            if (m.id != null && !m.id.isEmpty()) ids.add(m.id);
        }
        Notifier.receive(ctx, batch, true);
        if (ids.isEmpty()) return;
        StringBuilder sb = new StringBuilder();
        for (String id : ids) {
            if (sb.length() > 0) sb.append(',');
            sb.append(JSONObject.quote(id));
        }
        c.sendText("{\"type\":\"ack\",\"ids\":[" + sb + "]}");
    }

    private static void showMessage(Context ctx, MessageItem m) {
        Notifier.receive(ctx, java.util.Collections.singletonList(m), false);
    }
}