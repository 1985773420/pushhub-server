package com.pushhub.app;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.imageview.ShapeableImageView;
import com.pushhub.app.msg.Attachment;
import com.pushhub.app.msg.MessageItem;
import com.pushhub.app.msg.MessageStore;
import com.pushhub.app.prefs.AppPrefs;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 单条消息的完整查看页。
 *
 * 只通过 Intent 传 id 和最多 500 字预览，正文按以下顺序取：
 *   1) 进程内 MessageStore（列表点进来时命中）
 *   2) 服务端 GET /api/messages?id=…（通知点击、进程被杀后）
 * 这样再长的正文也不会进 Binder / PendingIntent。
 */
public class MessageDetailActivity extends AppCompatActivity {
    private static final int PREVIEW_MAX = 500;

    private MessageItem item;
    private String id;
    private String source;
    private String title;
    private String url;
    private long ts;

    private TextView sourceView;
    private TextView timeView;
    private TextView titleView;
    private TextView bodyView;
    private TextView urlView;
    private View linkCard;
    private View attachmentsSection;
    private LinearLayout attachmentsList;
    private com.google.android.material.button.MaterialButton confirmButton;
    private boolean loading;

    public static Intent intentFor(Context ctx, MessageItem m) {
        String preview = m.body == null ? "" : m.body;
        if (preview.length() > PREVIEW_MAX) preview = preview.substring(0, PREVIEW_MAX) + "…";
        return new Intent(ctx, MessageDetailActivity.class)
                .putExtra("id", m.id)
                .putExtra("source", m.source)
                .putExtra("title", m.title)
                .putExtra("url", m.url)
                .putExtra("ts", m.ts)
                .putExtra("priority", m.priority)
                .putExtra("preview", preview)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_message);

        Intent i = getIntent();
        id = i.getStringExtra("id");
        source = i.getStringExtra("source");
        title = i.getStringExtra("title");
        url = i.getStringExtra("url");
        ts = i.getLongExtra("ts", System.currentTimeMillis());
        String preview = i.getStringExtra("preview");

        com.google.android.material.appbar.MaterialToolbar toolbar = findViewById(R.id.toolbar);
        toolbar.setNavigationOnClickListener(v -> finish());

        sourceView = findViewById(R.id.detailSource);
        timeView = findViewById(R.id.detailTime);
        titleView = findViewById(R.id.detailTitle);
        bodyView = findViewById(R.id.detailBody);
        urlView = findViewById(R.id.detailUrl);
        linkCard = findViewById(R.id.linkCard);
        attachmentsSection = findViewById(R.id.attachmentsSection);
        attachmentsList = findViewById(R.id.attachmentsList);

        findViewById(R.id.copyButton).setOnClickListener(v -> copyAll());
        findViewById(R.id.openButton).setOnClickListener(v -> openLink());

        confirmButton = findViewById(R.id.confirmButton);
        confirmButton.setEnabled(false);
        confirmButton.setOnClickListener(v -> {
            if (item == null) {
                Toast.makeText(this, R.string.detail_confirm_loading, Toast.LENGTH_SHORT).show();
                return;
            }
            Receipts.enqueue(this, item.id, "confirmed");
            confirmButton.setText(R.string.detail_confirmed);
            confirmButton.setEnabled(false);
        });
        renderHeader();
        bodyView.setText(TextUtils.isEmpty(preview) ? getString(R.string.detail_loading) : preview);

        MessageItem cached = MessageStore.find(id);
        if (cached != null) {
            bind(cached);
        } else {
            loadFromServer();
        }
    }

    @Override
    public boolean onSupportNavigateUp() {
        finish();
        return true;
    }

    private void renderHeader() {
        try {
            sourceView.setText(App.sourceName(source));
            sourceView.setTextColor(Color.parseColor("#64748B"));
            View dot = findViewById(R.id.detailDot);
            dot.setBackgroundTintList(ColorStateList.valueOf(Color.parseColor(App.sourceColor(source))));
        } catch (Exception ignored) {
        }
        titleView.setText(TextUtils.isEmpty(title) ? App.sourceName(source) : title);
        timeView.setText(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(new Date(ts)));
        if (!TextUtils.isEmpty(url)) {
            linkCard.setVisibility(View.VISIBLE);
            urlView.setText(url);
        } else {
            linkCard.setVisibility(View.GONE);
        }
    }

    private void bind(MessageItem m) {
        item = m;
        title = m.title;
        url = m.url;
        ts = m.ts;
        source = m.source;
        renderHeader();
        bodyView.setText(TextUtils.isEmpty(m.body) ? getString(R.string.detail_empty) : m.body);
        renderAttachments(m.attachments);
        Receipts.enqueue(this, m.id, "opened");
        loading = false;
    }

    /** 附件区：图片直接显示缩略图，视频/文档用行卡片；点击交给系统对应应用打开。 */
    private void renderAttachments(List<Attachment> attachments) {
        attachmentsList.removeAllViews();
        if (attachments == null || attachments.isEmpty()) {
            attachmentsSection.setVisibility(View.GONE);
            return;
        }
        attachmentsSection.setVisibility(View.VISIBLE);
        String base = AppPrefs.get(this).serverUrl();
        LayoutInflater inflater = LayoutInflater.from(this);
        for (int i = 0; i < attachments.size(); i++) {
            Attachment a = attachments.get(i);
            View row;
            if (a.isImage()) {
                row = inflater.inflate(R.layout.item_attachment_image, attachmentsList, false);
                ShapeableImageView image = row.findViewById(R.id.attachmentImage);
                image.setContentDescription(a.name);
                ImageLoader.load(image, a.absoluteUrl(base));
            } else {
                row = inflater.inflate(R.layout.item_attachment_file, attachmentsList, false);
                ImageView icon = row.findViewById(R.id.attachmentIcon);
                icon.setImageResource(a.isVideo() ? R.drawable.ic_video : R.drawable.ic_file);
                TextView name = row.findViewById(R.id.attachmentName);
                TextView meta = row.findViewById(R.id.attachmentMeta);
                name.setText(a.name);
                String kind = getString(a.isVideo() ? R.string.attachment_video : R.string.attachment_file);
                String size = a.displaySize();
                meta.setText(size.isEmpty() ? kind : kind + " · " + size);
            }
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.topMargin = dp(i == 0 ? 8 : 10);
            row.setOnClickListener(v -> openAttachment(a));
            attachmentsList.addView(row, lp);
        }
    }

    private void openAttachment(Attachment a) {
        String link = a.absoluteUrl(AppPrefs.get(this).serverUrl());
        try {
            Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(link));
            if (!TextUtils.isEmpty(a.mime)) open.setDataAndType(Uri.parse(link), a.mime);
            startActivity(open);
        } catch (ActivityNotFoundException | IllegalArgumentException e) {
            Toast.makeText(this, R.string.attachment_open_failed, Toast.LENGTH_SHORT).show();
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void loadFromServer() {
        AppPrefs prefs = AppPrefs.get(this);
        if (!prefs.isPaired() || prefs.token() == null || TextUtils.isEmpty(id)) {
            bodyView.setText(R.string.detail_load_failed);
            return;
        }
        loading = true;
        final String reqUrl = prefs.serverUrl() + "/api/messages?id="
                + URLEncoder.encode(id) + "&token=" + URLEncoder.encode(prefs.token());
        new Thread(() -> {
            HttpURLConnection conn = null;
            MessageItem fetched = null;
            try {
                conn = (HttpURLConnection) new URL(reqUrl).openConnection();
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(15_000);
                if (conn.getResponseCode() == 200) {
                    String text = readAll(conn.getInputStream());
                    JSONObject root = new JSONObject(text);
                    JSONObject m = root.optJSONObject("message");
                    if (m != null) fetched = MessageItem.fromJson(m);
                }
            } catch (Exception ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
            final MessageItem result = fetched;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (result != null) {
                    bind(result);
                } else {
                    loading = false;
                    bodyView.setText(R.string.detail_load_failed);
                }
            });
        }, "message-detail").start();
    }

    private void copyAll() {
        String body = item != null ? item.body : bodyView.getText().toString();
        String t = item != null ? item.title : title;
        String text = (TextUtils.isEmpty(t) ? "" : t + "\n\n") + (body == null ? "" : body);
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) {
            cm.setPrimaryClip(ClipData.newPlainText("PushHub 消息", text));
            Toast.makeText(this, R.string.detail_copied, Toast.LENGTH_SHORT).show();
        }
    }

    private void openLink() {
        String link = item != null ? item.url : url;
        if (TextUtils.isEmpty(link)) {
            Toast.makeText(this, R.string.detail_no_link, Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(link)));
        } catch (Exception e) {
            Toast.makeText(this, R.string.detail_no_link, Toast.LENGTH_SHORT).show();
        }
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }
}