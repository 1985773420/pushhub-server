package com.pushhub.app;

import android.app.Application;
import android.content.Context;

import com.pushhub.app.msg.MessageItem;
import com.pushhub.app.msg.MessageStore;
import com.pushhub.app.prefs.AppPrefs;
import com.pushhub.app.ws.WsClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/** 全局状态：连接状态、来源表、当前 WsClient，供 Activity / 服务共享。 */
public class App extends Application {
    public enum Status {CONNECTING, CONNECTED, OFFLINE, REPLACED, UNAUTHORIZED, PAUSED}

    public static final class SourceInfo {
        public final String id;
        public String name;
        public String color;
        public String priority;

        SourceInfo(String id) {
            this.id = id;
        }
    }

    private static App instance;

    // 连接状态
    private static volatile Status status = Status.OFFLINE;
    private static volatile int retryInSec;
    private static final CopyOnWriteArrayList<Runnable> stateListeners = new CopyOnWriteArrayList<>();

    // 来源表（来自 hello 或重新加载）
    private static final Map<String, SourceInfo> sources = new LinkedHashMap<>();
    private static volatile WsClient client;

    @Override
    public void onCreate() {
        instance = this;
        CrashLogger.install();
        super.onCreate();
        MessageStore.initialize();
        if (AppPrefs.get(this).paused()) status = Status.PAUSED;
    }

    public static App get() {
        return instance;
    }

    public static Context ctx() {
        return instance;
    }

    // ---------- 状态 ----------
    public static Status status() {
        return status;
    }

    public static int retryInSec() {
        return retryInSec;
    }

    public static void setStatus(Status s) {
        setStatus(s, 0);
    }

    public static void setStatus(Status s, int retry) {
        status = s;
        retryInSec = retry;
        fire();
    }

    public static void setClient(WsClient c) {
        client = c;
        fire();
    }

    public static WsClient client() {
        return client;
    }

    public static void addStateListener(Runnable r) {
        stateListeners.add(r);
    }

    public static void removeStateListener(Runnable r) {
        stateListeners.remove(r);
    }

    private static void fire() {
        for (Runnable r : stateListeners) {
            try {
                r.run();
            } catch (Exception ignored) {
            }
        }
    }

    // ---------- 来源 ----------
    public static Map<String, SourceInfo> sources() {
        synchronized (sources) {
            return new LinkedHashMap<>(sources);
        }
    }

    public static void setSourcesFromHello(JSONObject hello) {
        JSONArray arr = hello.optJSONArray("sources");
        if (arr == null) return;
        synchronized (sources) {
            sources.clear();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                SourceInfo si = new SourceInfo(o.optString("id", "?"));
                si.name = o.optString("name", si.id);
                si.color = o.optString("color", "#5B8DEF");
                si.priority = o.optString("defaultPriority", "normal");
                sources.put(si.id, si);
            }
        }
        fire();
    }

    public static SourceInfo sourceInfo(String id) {
        synchronized (sources) {
            return sources.get(id);
        }
    }

    public static String sourceName(String id) {
        if ("self".equals(id)) return "自检";
        SourceInfo si = sourceInfo(id);
        return si == null ? id : si.name;
    }

    public static String sourceColor(String id) {
        SourceInfo si = sourceInfo(id);
        return si == null ? "#5B8DEF" : si.color;
    }

    public static void storeHello(JSONObject o) {
        setSourcesFromHello(o);

    }
}