package com.pushhub.app;

import android.content.Context;
import android.content.SharedPreferences;
import com.pushhub.app.prefs.AppPrefs;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Durable per-device outbox. Failed requests remain across process restarts. */
public final class Receipts {
    private static final java.util.concurrent.ExecutorService worker = java.util.concurrent.Executors.newSingleThreadExecutor();
    public static synchronized void enqueue(Context ctx, String id, String status) {
        if (id == null || id.isEmpty()) return;
        AppPrefs p = AppPrefs.get(ctx);
        if (!p.isPaired()) return;
        SharedPreferences sp = ctx.getSharedPreferences("receipts-" + p.deviceId(), 0);
        String old = sp.getString(id, "");
        String states = "received opened confirmed";
        if (states.indexOf(status) >= states.indexOf(old)) sp.edit().putString(id, status).commit();
        flush(ctx);
    }
    public static void flush(Context ctx) {
        Context app = ctx.getApplicationContext();
        worker.execute(() -> {
            AppPrefs p = AppPrefs.get(app);
            if (!p.isPaired()) return;
            String token = p.token();
            SharedPreferences sp = app.getSharedPreferences("receipts-" + p.deviceId(), 0);
            for (java.util.Map.Entry<String, ?> entry : sp.getAll().entrySet()) {
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(p.serverUrl() + "/api/receipts").openConnection();
                    c.setRequestMethod("POST"); c.setConnectTimeout(8000); c.setReadTimeout(8000);
                    c.setRequestProperty("Authorization", "Bearer " + token);
                    c.setRequestProperty("Content-Type", "application/json"); c.setDoOutput(true);
                    byte[] body = new JSONObject().put("id", entry.getKey()).put("status", entry.getValue()).toString().getBytes(StandardCharsets.UTF_8);
                    try (java.io.OutputStream out = c.getOutputStream()) { out.write(body); }
                    int code = c.getResponseCode();
                    if (code == 200 || code == 404) synchronized (Receipts.class) {
                        if (entry.getValue().equals(sp.getString(entry.getKey(), ""))) sp.edit().remove(entry.getKey()).commit();
                    }
                } catch (Exception ignored) { break; }
                finally { if (c != null) c.disconnect(); }
            }
        });
    }
}
