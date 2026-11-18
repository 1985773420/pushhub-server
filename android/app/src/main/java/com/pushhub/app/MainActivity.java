package com.pushhub.app;

import android.Manifest;
import android.app.AlarmManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.LayoutInflater;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.materialswitch.MaterialSwitch;
import com.google.android.material.textfield.TextInputEditText;
import com.pushhub.app.msg.MessageStore;
import com.pushhub.app.notify.LiveUpdate;
import com.pushhub.app.notify.Notifier;
import com.pushhub.app.prefs.AppPrefs;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** 配对 + 状态 + 来源管理 + 历史。 */
public class MainActivity extends AppCompatActivity {
    private final androidx.activity.result.ActivityResultLauncher<com.journeyapps.barcodescanner.ScanOptions> scanner = registerForActivityResult(new com.journeyapps.barcodescanner.ScanContract(), result -> {
        if (result.getContents() == null) return;
        try {
            String[] pair = PairQr.parse(result.getContents());
            this.serverInput.setText(pair[0]); this.codeInput.setText(pair[1]);
            Toast.makeText(this, "已填入服务器和配对码，请检查后点击配对", Toast.LENGTH_LONG).show();
        } catch (Exception e) { showPairError("不是有效的 PushHub 配对二维码，请手动填写"); }
    });
    private static final int REQ_NOTIF = 100;

    private View pairPanel;
    private View mainPanel;
    private TextInputEditText serverInput;
    private TextInputEditText codeInput;
    private TextInputEditText deviceNameInput;
    private MaterialButton pairButton;
    private TextView pairError;

    private MaterialToolbar toolbar;
    private SwipeRefreshLayout refreshLayout;
    private View statusDot;
    private TextView statusText;
    private TextView serverText;
    private MaterialButton testButton;
    private MaterialButton pauseButton;
    private LinearLayout sourcesList;
    private MaterialSwitch silentSwitch;
    private MaterialSwitch liveSwitch;
    private TextView liveHint;
    private View keepAliveRow;
    private View notifSettingsRow;
    private RecyclerView historyList;
    private RecyclerView.Adapter<?> adapter;
    private TextView historyCount;
    private View emptyState;
    private MaterialButton repairButton;
    private MaterialButton unpairButton;

    private android.widget.EditText historySearch;
    private String historySource;
    private int historyQueryVersion;
    private final java.util.concurrent.ExecutorService historyExecutor = java.util.concurrent.Executors.newSingleThreadExecutor();
    private HistoryAdapter historyAdapter;
    private AppPrefs prefs;

    private final Runnable stateListener = () -> runOnUiThread(this::renderState);
    private final Runnable historyListener = () -> runOnUiThread(this::renderHistory);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        prefs = AppPrefs.get(this);

        pairPanel = findViewById(R.id.pairPanel);
        mainPanel = findViewById(R.id.mainPanel);
        serverInput = findViewById(R.id.serverInput);
        codeInput = findViewById(R.id.codeInput);
        deviceNameInput = findViewById(R.id.deviceNameInput);
        pairButton = findViewById(R.id.pairButton);
        pairError = findViewById(R.id.pairError);

        toolbar = findViewById(R.id.toolbar);
        setSupportActionBar(toolbar);
        toolbar.setTitle(R.string.app_name);

        refreshLayout = findViewById(R.id.refreshLayout);
        statusDot = findViewById(R.id.statusDot);
        statusText = findViewById(R.id.statusText);
        serverText = findViewById(R.id.serverText);
        testButton = findViewById(R.id.testButton);
        pauseButton = findViewById(R.id.pauseButton);
        sourcesList = findViewById(R.id.sourcesList);
        silentSwitch = findViewById(R.id.silentSwitch);
        liveSwitch = findViewById(R.id.liveSwitch);
        liveHint = findViewById(R.id.liveHint);
        keepAliveRow = findViewById(R.id.keepAliveRow);
        notifSettingsRow = findViewById(R.id.notifSettingsRow);
        historyList = findViewById(R.id.historyList);
        historyCount = findViewById(R.id.historyCount);
        emptyState = findViewById(R.id.emptyState);
        repairButton = findViewById(R.id.repiarButton);
        unpairButton = findViewById(R.id.unpairButton);

        historyAdapter = new HistoryAdapter();
        historyList.setLayoutManager(new LinearLayoutManager(this));
        historyList.setAdapter(historyAdapter);
        adapter = historyAdapter;
        LinearLayout historyParent = (LinearLayout) historyList.getParent();
        historySearch = new android.widget.EditText(this);
        historySearch.setSingleLine(true);
        historySearch.setHint("搜索标题 / 正文（本地保留最近10000条）");
        historySearch.setTextSize(14);
        historyParent.addView(historySearch, historyParent.indexOfChild(historyList));
        MaterialButton sourceFilter = new MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
        sourceFilter.setText("全部来源 ▾");
        historyParent.addView(sourceFilter, historyParent.indexOfChild(historyList));
        sourceFilter.setOnClickListener(v -> {
            historyExecutor.execute(() -> {
                List<String> ids = MessageStore.sources();
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    String[] labels = new String[ids.size() + 1]; labels[0] = "全部来源";
                    for (int i = 0; i < ids.size(); i++) labels[i + 1] = App.sourceName(ids.get(i));
                    new MaterialAlertDialogBuilder(this).setTitle("筛选来源").setItems(labels, (d, which) -> {
                        historySource = which == 0 ? null : ids.get(which - 1);
                        sourceFilter.setText(labels[which] + " ▾"); renderHistory();
                    }).show();
                });
            });
        });
        historySearch.addTextChangedListener(new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { renderHistory(); }
            public void afterTextChanged(android.text.Editable e) {}
        });

        deviceNameInput.setText(prefs.deviceName().isEmpty() ? Build.MODEL : prefs.deviceName());

        MaterialButton scan = new MaterialButton(this);
        scan.setText("扫描配对二维码");
        ((android.view.ViewGroup) pairButton.getParent()).addView(scan);
        scan.setOnClickListener(v -> scanner.launch(new com.journeyapps.barcodescanner.ScanOptions().setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE).setPrompt("扫描控制台配对二维码；取消后可手动填写").setBeepEnabled(false).setCaptureActivity(PairCaptureActivity.class).setOrientationLocked(true)));
        serverText.setOnClickListener(v -> showDiagnostics());
        serverText.setContentDescription("点击查看连接诊断");
        pairButton.setOnClickListener(v -> doPair());
        testButton.setOnClickListener(v -> sendSelfTest());
        pauseButton.setOnClickListener(v -> togglePause());
        keepAliveRow.setOnClickListener(v -> requestBatteryExemption());
        notifSettingsRow.setOnClickListener(v -> openAppNotificationSettings());
        repairButton.setOnClickListener(v -> showPairPanel(true));
        unpairButton.setOnClickListener(v -> confirmUnpair());

        refreshLayout.setOnRefreshListener(this::refreshNow);

        silentSwitch.setChecked(prefs.silentMode());
        silentSwitch.setOnCheckedChangeListener((btn, checked) -> {
            prefs.setSilent(checked);
            Notifier.applySilent(this, checked);
        });

        liveSwitch.setChecked(prefs.liveUpdates());
        liveSwitch.setOnCheckedChangeListener((btn, checked) -> {
            prefs.setLiveUpdates(checked);
            if (!checked) LiveUpdate.cancel(this);
            renderLiveHint();
        });

        askNotificationPermission();

        if (prefs.isPaired()) {
            showMain();
            ConnectionService.start(this);
        } else {
            showPairPanel(false);
        }
        renderHistory();
        maybeShowCrashLog();
    }

    // ---------------------------------------------------------------- 菜单

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.main_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.action_refresh) {
            refreshNow();
            return true;
        } else if (id == R.id.action_notify_settings) {
            openAppNotificationSettings();
            return true;
        } else if (id == R.id.action_keepalive) {
            requestBatteryExemption();
            return true;
        } else if (id == R.id.action_repair) {
            showPairPanel(true);
            return true;
        } else if (id == R.id.action_unpair) {
            confirmUnpair();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private void showDiagnostics() {
        StringBuilder text = new StringBuilder("连接状态：" + App.status() + "\n通知权限：" + androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled());
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        text.append("\n忽略电池优化：").append(pm.isIgnoringBatteryOptimizations(getPackageName()));
        for (String key : new String[]{"attempt", "connected", "disconnected", "error"}) text.append("\n").append(key).append("：").append(getSharedPreferences("diagnostics", 0).getString(key, "尚无记录"));
        text.append("\n设备接收仅表示本地收到，不保证系统通知可见。自检需要主动点击主页自检按钮。");
        new MaterialAlertDialogBuilder(this).setTitle("连接诊断").setMessage(text).setPositiveButton("关闭", null).show();
    }

    private void refreshNow() {
        Receipts.flush(this);
        refreshLayout.setRefreshing(true);
        HistorySync.run(this);
        if (prefs.isPaired() && !prefs.paused() && App.status() != App.Status.CONNECTED) {
            ConnectionService.start(this);
        }
        refreshLayout.postDelayed(() -> refreshLayout.setRefreshing(false), 900);
    }

    // ---------------------------------------------------------------- 崩溃日志

    private void maybeShowCrashLog() {
        String crash = CrashLogger.read(this);
        if (crash == null || crash.isEmpty()) return;
        TextView tv = new TextView(this);
        tv.setText(crash);
        tv.setTextSize(11);
        tv.setTextIsSelectable(true);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        tv.setPadding(pad, pad, pad, pad);
        ScrollView sv = new ScrollView(this);
        sv.addView(tv);
        new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.crash_title)
                .setView(sv)
                .setPositiveButton(R.string.crash_copy, (d, w) -> {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("PushHub crash", crash));
                    Toast.makeText(this, R.string.crash_copied, Toast.LENGTH_SHORT).show();
                })
                .setNegativeButton(R.string.crash_clear, (d, w) -> CrashLogger.clear(this))
                .setNeutralButton("关闭", null)
                .show();
    }

    @Override
    protected void onStart() {
        super.onStart();
        // 用户打开 App 即视为已读，结束状态栏/流体云上的实况卡。
        LiveUpdate.cancel(this);
        App.addStateListener(stateListener);
        MessageStore.watch(historyListener);
        renderState();
        renderHistory();
    }

    @Override
    protected void onDestroy() {
        historyExecutor.shutdown();
        super.onDestroy();
    }

    @Override
    protected void onStop() {
        App.removeStateListener(stateListener);
        MessageStore.unwatch(historyListener);
        super.onStop();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        renderState();
    }

    // ---------------------------------------------------------------- 配对

    private void showPairPanel(boolean prefill) {
        pairPanel.setVisibility(View.VISIBLE);
        mainPanel.setVisibility(View.GONE);
        if (prefill && !prefs.serverUrl().isEmpty()) serverInput.setText(prefs.serverUrl());
        pairError.setVisibility(View.GONE);
    }

    private void showMain() {
        pairPanel.setVisibility(View.GONE);
        mainPanel.setVisibility(View.VISIBLE);
        renderState();
    }

    private void doPair() {
        String server = normalizeServer(text(serverInput));
        String code = text(codeInput).replaceAll("[^A-Za-z0-9]", "").toUpperCase();
        String name = text(deviceNameInput).trim();
        if (TextUtils.isEmpty(server)) {
            showPairError("请填写服务器地址");
            return;
        }
        if (code.length() < 6) {
            showPairError("配对码应为 8 位");
            return;
        }
        if (name.isEmpty()) name = Build.MODEL;
        pairError.setVisibility(View.GONE);
        pairButton.setEnabled(false);
        pairButton.setText(R.string.pairing_msg);
        final String serverF = server;
        final String codeF = code;
        final String nameF = name;
        new Thread(() -> {
            try {
                JSONObject req = new JSONObject();
                req.put("code", codeF);
                req.put("deviceName", nameF);
                JSONObject res = httpJson("POST", serverF + "/api/pair", req.toString());
                String token = res.optString("deviceToken", "");
                String deviceId = res.optString("deviceId", "");
                String wsPath = res.optString("wsPath", "/ws");
                if (token.isEmpty()) throw new IllegalStateException(res.optString("error", "服务器返回异常"));
                prefs.savePair(serverF, token, deviceId, wsPath, nameF);
                runOnUiThread(() -> {
                    pairButton.setEnabled(true);
                    pairButton.setText(R.string.pair_button);
                    showMain();
                    prefs.setPaused(false);
                    ConnectionService.start(MainActivity.this);
                });
            } catch (Exception e) {
                String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                runOnUiThread(() -> {
                    pairButton.setEnabled(true);
                    pairButton.setText(R.string.pair_button);
                    showPairError(getString(R.string.pair_error, msg));
                });
            }
        }, "pair").start();
    }

    private static String text(TextView v) {
        return v.getText() == null ? "" : v.getText().toString();
    }

    private void showPairError(String msg) {
        pairError.setText(msg);
        pairError.setVisibility(View.VISIBLE);
    }

    private static String normalizeServer(String s) {
        if (s == null) return "";
        s = s.trim();
        if (s.isEmpty()) return "";
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private static JSONObject httpJson(String method, String url, String body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(20_000);
        conn.setRequestProperty("content-type", "application/json; charset=utf-8");
        conn.setRequestProperty("accept", "application/json");
        if (body != null) {
            conn.setDoOutput(true);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = conn.getResponseCode();
        InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        String responseText = readAll(is);
        JSONObject o = responseText.isEmpty() ? new JSONObject() : new JSONObject(responseText);
        if (code >= 400) {
            throw new IllegalStateException(o.optString("error", "HTTP " + code));
        }
        return o;
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    // ---------------------------------------------------------------- 渲染

    private void renderState() {
        if (!prefs.isPaired()) {
            if (mainPanel.getVisibility() == View.VISIBLE) showPairPanel(false);
            return;
        }
        App.Status st = App.status();
        int color;
        String text;
        switch (st) {
            case CONNECTED:
                color = color(R.color.ok_green);
                text = getString(R.string.status_connected, prefs.baseForDisplay());
                break;
            case CONNECTING:
                color = color(R.color.warn_amber);
                text = getString(R.string.status_connecting);
                break;
            case PAUSED:
                color = color(R.color.status_gray);
                text = getString(R.string.status_paused);
                break;
            case REPLACED:
                color = color(R.color.err_red);
                text = getString(R.string.status_replaced);
                break;
            case UNAUTHORIZED:
                color = color(R.color.err_red);
                text = getString(R.string.status_unauthorized);
                break;
            default:
                color = color(R.color.warn_amber);
                text = getString(R.string.status_offline, Math.max(1, App.retryInSec()));
                break;
        }
        statusText.setText(text);
        statusDot.setBackgroundTintList(ColorStateList.valueOf(color));
        serverText.setText(prefs.baseForDisplay()
                + (prefs.deviceName().isEmpty() ? "" : " · " + prefs.deviceName()));

        boolean paused = prefs.paused();
        pauseButton.setText(paused ? R.string.resume : R.string.pause);
        testButton.setEnabled(st == App.Status.CONNECTED);
        testButton.setAlpha(st == App.Status.CONNECTED ? 1f : 0.55f);

        toolbar.setSubtitle(prefs.baseForDisplay());

        silentSwitch.setChecked(prefs.silentMode());
        liveSwitch.setChecked(prefs.liveUpdates());
        renderLiveHint();
        rebuildSources();
    }

    private int color(int res) {
        return ContextCompat.getColor(this, res);
    }

    private void renderLiveHint() {
        if (!prefs.liveUpdates()) {
            liveHint.setText(R.string.live_disabled);
            liveHint.setClickable(false);
            liveHint.setOnClickListener(null);
            return;
        }
        if (Build.VERSION.SDK_INT < 36) {
            liveHint.setText(R.string.live_unsupported);
            liveHint.setClickable(false);
            liveHint.setOnClickListener(null);
            return;
        }
        if (LiveUpdate.canPromote(this)) {
            liveHint.setText(R.string.live_on);
            liveHint.setClickable(true);
            liveHint.setOnClickListener(v -> openAppNotificationSettings());
        } else {
            liveHint.setText(R.string.live_off_system);
            liveHint.setClickable(true);
            liveHint.setOnClickListener(v -> openLiveUpdateSettings());
        }
    }

    private void openLiveUpdateSettings() {
        if (Build.VERSION.SDK_INT >= 36) {
            try {
                // 常量在部分 36.0 SDK 里还没暴露，用系统约定字符串；找不到页面会自动回退。
                startActivity(new Intent("android.settings.MANAGE_APP_PROMOTED_NOTIFICATIONS",
                        Uri.parse("package:" + getPackageName())));
                return;
            } catch (Exception ignored) {
            }
        }
        openAppNotificationSettings();
    }

    private void openAppNotificationSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        } catch (Exception e) {
            Toast.makeText(this, "无法打开通知设置", Toast.LENGTH_SHORT).show();
        }
    }

    private void renderHistory() {
        if (historyList.isComputingLayout()) {
            historyList.post(this::renderHistory);
            return;
        }
        final int version = ++historyQueryVersion;
        final String query = historySearch == null ? "" : historySearch.getText().toString();
        final String source = historySource;
        historyExecutor.execute(() -> {
            List<com.pushhub.app.msg.MessageItem> snap = MessageStore.search(query, source);
            runOnUiThread(() -> {
                if (isDestroyed() || version != historyQueryVersion) return;
                historyAdapter.setItems(snap);
                historyCount.setText((query.isEmpty() && source == null ? "最近 " : "匹配 ") + snap.size() + " 条（最多500条）");
                boolean empty = snap.isEmpty();
                emptyState.setVisibility(empty ? View.VISIBLE : View.GONE);
                historyList.setVisibility(empty ? View.GONE : View.VISIBLE);
            });
        });
    }

    private void rebuildSources() {
        Set<String> muted = prefs.mutedSources();
        Map<String, App.SourceInfo> map = App.sources();
        sourcesList.removeAllViews();
        if (map.isEmpty()) {
            TextView tv = new TextView(this);
            tv.setText(R.string.source_empty);
            tv.setTextColor(color(R.color.text_secondary));
            tv.setTextSize(12.5f);
            int p = (int) (16 * getResources().getDisplayMetrics().density);
            tv.setPadding(p, p, p, p);
            sourcesList.addView(tv);
            return;
        }
        LayoutInflater inflater = LayoutInflater.from(this);
        for (App.SourceInfo si : map.values()) {
            View row = inflater.inflate(R.layout.item_source, sourcesList, false);
            View dot = row.findViewById(R.id.sourceDot);
            try {
                dot.setBackgroundTintList(ColorStateList.valueOf(Color.parseColor(si.color)));
            } catch (Exception ignored) {
            }
            ((TextView) row.findViewById(R.id.sourceName)).setText(si.name);
            ((TextView) row.findViewById(R.id.sourceId)).setText(si.id + " · " + (prefs.quietEnabled(si.id)
                    ? "免打扰 " + clock(prefs.quietStart(si.id)) + "–" + clock(prefs.quietEnd(si.id)) : "点击设置免打扰"));
            row.setOnClickListener(v -> editQuiet(si.id, si.name));
            MaterialSwitch sw = row.findViewById(R.id.sourceSwitch);
            sw.setChecked(!muted.contains(si.id));
            sw.setOnCheckedChangeListener((btn, checked) -> prefs.setMuted(si.id, !checked));
            sourcesList.addView(row);
        }
    }

    private static String clock(int minute) {
        return String.format(java.util.Locale.ROOT, "%02d:%02d", minute / 60, minute % 60);
    }

    private void editQuiet(String source, String name) {
        LinearLayout panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (24 * getResources().getDisplayMetrics().density); panel.setPadding(pad, 0, pad, 0);
        MaterialSwitch enabled = new MaterialSwitch(this); enabled.setText("启用每天免打扰（仅保存，不通知）");
        enabled.setChecked(prefs.quietEnabled(source)); panel.addView(enabled);
        int[] times = {prefs.quietStart(source), prefs.quietEnd(source)};
        for (int i = 0; i < 2; i++) {
            final int index = i;
            MaterialButton button = new MaterialButton(this);
            String label = i == 0 ? "开始 " : "结束 ";
            button.setText(label + clock(times[i])); panel.addView(button);
            button.setOnClickListener(v -> new android.app.TimePickerDialog(this, (picker, hour, minute) -> {
                times[index] = hour * 60 + minute; button.setText(label + clock(times[index]));
            }, times[index] / 60, times[index] % 60, true).show());
        }
        TextView hint = new TextView(this); hint.setText("按手机本地时间；支持跨午夜。开始与结束相同表示全天。结束后不补发通知，历史仍可搜索。"); panel.addView(hint);
        new MaterialAlertDialogBuilder(this).setTitle(name + " · 免打扰").setView(panel)
                .setNegativeButton("取消", null).setPositiveButton("保存", (d, w) -> {
                    prefs.setQuiet(source, enabled.isChecked(), times[0], times[1]); rebuildSources();
                }).show();
    }

    // ---------------------------------------------------------------- 操作

    private void sendSelfTest() {
        com.pushhub.app.ws.WsClient c = App.client();
        if (c == null || !c.isOpen() || App.status() != App.Status.CONNECTED) {
            Toast.makeText(this, "当前未连接，稍等或检查服务器", Toast.LENGTH_SHORT).show();
            return;
        }
        c.sendText("{\"type\":\"echo\"}");
        Toast.makeText(this, R.string.test_sent, Toast.LENGTH_SHORT).show();
    }

    private void togglePause() {
        if (prefs.paused()) {
            prefs.setPaused(false);
            App.setStatus(App.Status.CONNECTING);
            ConnectionService.start(this);
        } else {
            prefs.setPaused(true);
            ConnectionService.stop(this);
            App.setStatus(App.Status.PAUSED);
        }
        renderState();
    }

    /** 后台保活引导：列出关键系统开关，逐项跳转。 */
    private void requestBatteryExemption() {
        boolean batteryOk = isIgnoringBatteryOptimizations();
        boolean exactOk = canScheduleExact();
        String status = "当前状态：" + (batteryOk ? "已忽略电池优化" : "未忽略电池优化")
                + " · " + (exactOk ? "精确闹钟已允许" : "精确闹钟未允许");
        new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.keepalive_title)
                .setMessage(getString(R.string.keepalive_body) + "\n\n" + status)
                .setNeutralButton(R.string.keepalive_alarm, (d, w) -> requestExactAlarmPermission())
                .setNegativeButton(R.string.keepalive_appinfo, (d, w) -> openAppDetailSettings())
                .setPositiveButton(R.string.keepalive_battery, (d, w) -> requestIgnoreBattery())
                .setOnDismissListener(d -> renderState())
                .show();
    }

    private boolean isIgnoringBatteryOptimizations() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    private boolean canScheduleExact() {
        try {
            if (Build.VERSION.SDK_INT < 31) return true;
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            return am != null && am.canScheduleExactAlarms();
        } catch (Exception e) {
            return false;
        }
    }

    private void requestIgnoreBattery() {
        try {
            if (isIgnoringBatteryOptimizations()) {
                Toast.makeText(this, "已忽略电池优化，后台接收会更稳", Toast.LENGTH_SHORT).show();
                return;
            }
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
            prefs.setBatteryRequested();
        } catch (Exception e) {
            try {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception ignored) {
                Toast.makeText(this, "此设备未提供电池优化设置页", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private void requestExactAlarmPermission() {
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                        Uri.parse("package:" + getPackageName())));
                return;
            } catch (Exception ignored) {
            }
        }
        openAppDetailSettings();
    }

    private void openAppDetailSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName())));
            Toast.makeText(this, "在「耗电管理 / 自启动」里允许后台运行与自启动", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "无法打开应用信息", Toast.LENGTH_SHORT).show();
        }
    }

    private void confirmUnpair() {
        new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.unpair)
                .setMessage("退出后本机不再接收推送，需要重新输入配对码。历史记录会清空。")
                .setNegativeButton("取消", null)
                .setPositiveButton(R.string.unpair, (d, w) -> {
                    synchronized (Notifier.class) {
                    prefs.clearPair();
                    prefs.setPaused(false);
                    ConnectionService.stop(this);
                    ServiceWatchdog.cancel(this);
                    LiveUpdate.cancel(this);
                    Notifier.clear(this);
                    }
                    historySource = null;
                    historySearch.setText("");
                    codeInput.setText("");
                    showPairPanel(false);
                })
                .show();
    }

    // ---------------------------------------------------------------- 权限

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_NOTIF && grantResults.length > 0
                && grantResults[0] != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "没有通知权限，将看不到推送；可在系统设置里开启", Toast.LENGTH_LONG).show();
        }
    }
}