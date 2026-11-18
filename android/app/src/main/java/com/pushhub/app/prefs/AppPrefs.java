package com.pushhub.app.prefs;

import android.content.Context;
import android.content.SharedPreferences;

import java.net.URI;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.HashSet;

/** 设备配对与设置的本地存储。 */
public final class AppPrefs {
    private static final String NAME = "pushhub";
    private static AppPrefs INSTANCE;

    private final SharedPreferences sp;

    public static synchronized AppPrefs get(Context ctx) {
        if (INSTANCE == null) INSTANCE = new AppPrefs(ctx.getApplicationContext());
        return INSTANCE;
    }

    private AppPrefs(Context ctx) {
        sp = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    public boolean isPaired() {
        return sp.getString("token", null) != null;
    }

    public String serverUrl() {
        String s = sp.getString("server", "");
        return s == null ? "" : trimSlash(s);
    }

    public String wsPath() {
        String p = sp.getString("wsPath", "/ws");
        return (p == null || p.isEmpty()) ? "/ws" : p;
    }

    public String token() {
        return sp.getString("token", null);
    }

    public String deviceId() {
        return sp.getString("deviceId", "");
    }

    public String deviceName() {
        return sp.getString("deviceName", "");
    }

    public void savePair(String server, String token, String deviceId, String wsPath, String deviceName) {
        sp.edit()
                .putString("server", trimSlash(server))
                .putString("token", token)
                .putString("deviceId", deviceId)
                .putString("wsPath", wsPath == null ? "/ws" : wsPath)
                .putString("deviceName", deviceName)
                .apply();
    }

    public void clearPair() {
        sp.edit()
                .remove("server")
                .remove("token")
                .remove("deviceId")
                .remove("wsPath")
                .remove("deviceName")
                .apply();
    }

    /** 由 ws 地址推导显示用 base：http(s)://host[:port] */
    public String baseForDisplay() {
        String base = serverUrl();
        try {
            URI u = URI.create(base);
            if (u.getHost() == null) return base;
            String out = u.getScheme() + "://" + u.getHost();
            if (u.getPort() > 0 && u.getPort() != 80 && u.getPort() != 443) out += ":" + u.getPort();
            return out;
        } catch (Exception e) {
            return base;
        }
    }

    /** 完整 ws 地址（用于连接）。 */
    public String wsUrl() {
        String base = serverUrl();
        if (!base.isEmpty()) {
            if (base.startsWith("https://")) base = "wss://" + base.substring(8);
            else if (base.startsWith("http://")) base = "ws://" + base.substring(7);
        }
        return base + wsPath() + "?token=" + token();
    }

    public Set<String> mutedSources() {
        return new HashSet<>(sp.getStringSet("mutedSources", new HashSet<>()));
    }

    public void setMuted(String sourceId, boolean muted) {
        Set<String> set = new LinkedHashSet<>(mutedSources());
        if (muted) set.add(sourceId);
        else set.remove(sourceId);
        sp.edit().putStringSet("mutedSources", set).apply();
    }

    public int quietStart(String source) { return sp.getInt("quiet.start." + source, 22 * 60); }
    public int quietEnd(String source) { return sp.getInt("quiet.end." + source, 8 * 60); }
    public boolean quietEnabled(String source) { return sp.getBoolean("quiet.enabled." + source, false); }
    public void setQuiet(String source, boolean enabled, int start, int end) {
        sp.edit().putBoolean("quiet.enabled." + source, enabled)
                .putInt("quiet.start." + source, start).putInt("quiet.end." + source, end).apply();
    }
    public boolean isQuiet(String source) {
        if (!quietEnabled(source)) return false;
        java.util.Calendar now = java.util.Calendar.getInstance();
        int minute = now.get(java.util.Calendar.HOUR_OF_DAY) * 60 + now.get(java.util.Calendar.MINUTE);
        return quietAt(quietStart(source), quietEnd(source), minute);
    }
    public static boolean quietAt(int start, int end, int minute) {
        return start == end || (start < end ? minute >= start && minute < end : minute >= start || minute < end);
    }

    public boolean silentMode() {
        return sp.getBoolean("silent", false);
    }

    public void setSilent(boolean s) {
        sp.edit().putBoolean("silent", s).apply();
    }

    public boolean liveUpdates() {
        return sp.getBoolean("liveUpdates", true);
    }

    public void setLiveUpdates(boolean v) {
        sp.edit().putBoolean("liveUpdates", v).apply();
    }

    public boolean paused() {
        return sp.getBoolean("paused", false);
    }

    public void setPaused(boolean p) {
        sp.edit().putBoolean("paused", p).apply();
    }

    public boolean batteryIgnoredRequested() {
        return sp.getBoolean("batteryReq", false);
    }

    public void setBatteryRequested() {
        sp.edit().putBoolean("batteryReq", true).apply();
    }

    private static String trimSlash(String s) {
        if (s == null) return "";
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }
}