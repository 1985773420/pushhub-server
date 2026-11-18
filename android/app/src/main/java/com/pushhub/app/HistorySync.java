package com.pushhub.app;

import android.content.Context;
import android.util.Log;

import com.pushhub.app.msg.MessageItem;
import com.pushhub.app.msg.MessageStore;
import com.pushhub.app.prefs.AppPrefs;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 从服务端拉回最近的消息历史（含完整正文与链接）。
 * App 进程被杀/重装后，查看端仍能看到此前的消息，而不只有本次连接收到的。
 */
public final class HistorySync {
    private static final String TAG = "PushHub.History";
    private static volatile long lastRun;

    private HistorySync() {
    }

    public static void run(Context ctx) {
        AppPrefs prefs = AppPrefs.get(ctx);
        if (!prefs.isPaired() || prefs.token() == null) return;
        long now = System.currentTimeMillis();
        if (now - lastRun < 15_000) return; // 重连抖动时别反复拉
        lastRun = now;

        final long generation = MessageStore.generation();
        final String token = prefs.token();
        final String server = prefs.serverUrl();
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                String url = server + "/api/messages?limit=50&token="
                        + URLEncoder.encode(token, "UTF-8");
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(15_000);
                int code = conn.getResponseCode();
                if (code != 200) return;
                String text = readAll(conn.getInputStream());
                JSONObject root = new JSONObject(text);
                JSONArray arr = root.optJSONArray("messages");
                if (arr == null || arr.length() == 0) return;

                // 服务端按时间倒序返回；MessageStore 按"最新在前"插入，这里从旧到新喂进去。
                List<MessageItem> items = new ArrayList<>();
                for (int i = arr.length() - 1; i >= 0; i--) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o != null) items.add(MessageItem.fromJson(o));
                }
                if (token.equals(prefs.token())) MessageStore.addAll(items, generation);
            } catch (Exception e) {
                Log.w(TAG, "history sync failed", e);
            } finally {
                if (conn != null) conn.disconnect();
            }
        }, "pushhub-history").start();
    }

    private static String readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }
}