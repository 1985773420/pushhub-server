package com.pushhub.app;

import android.content.Context;
import android.graphics.Color;
import android.content.res.ColorStateList;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.pushhub.app.msg.MessageItem;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** 主界面消息历史列表。 */
public class HistoryAdapter extends RecyclerView.Adapter<HistoryAdapter.VH> {
    private final List<MessageItem> items = new ArrayList<>();
    private final SimpleDateFormat todayFmt = new SimpleDateFormat("HH:mm", Locale.getDefault());
    private final SimpleDateFormat oldFmt = new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault());

    public void setItems(List<MessageItem> list) {
        items.clear();
        items.addAll(list);
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public VH onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View v = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_message, parent, false);
        return new VH(v);
    }

    @Override
    public void onBindViewHolder(@NonNull VH h, int position) {
        MessageItem m = items.get(position);
        h.sourceName.setText(App.sourceName(m.source));
        h.priorityChip.setVisibility("high".equals(m.priority) ? View.VISIBLE : View.GONE);
        h.title.setText(clip(m.title, 200));
        // 列表只渲染预览：20k 字的正文整段交给 TextView 会导致首屏布局卡死（看起来像闪退）。
        String preview = clip(m.body, 800);
        h.body.setText(preview);
        h.time.setText(fmt(m.ts));
        h.body.setVisibility(m.body == null || m.body.isEmpty() ? View.GONE : View.VISIBLE);
        int attachCount = m.attachments == null ? 0 : m.attachments.size();
        h.attachmentBadge.setVisibility(attachCount > 0 ? View.VISIBLE : View.GONE);
        if (attachCount > 0) h.attachmentBadge.setText(h.itemView.getContext().getString(R.string.attachment_count, attachCount));
        boolean longMessage = m.body != null && (m.body.length() > 90 || m.body.split("\n").length > 3);
        h.fullHint.setVisibility(longMessage ? View.VISIBLE : View.GONE);
        try {
            h.sourceDot.setBackgroundTintList(ColorStateList.valueOf(Color.parseColor(App.sourceColor(m.source))));
        } catch (Exception e) {
            h.sourceDot.setBackgroundTintList(ColorStateList.valueOf(Color.parseColor("#5B8DEF")));
        }
        // 点整条消息进入完整查看页（全文/复制/打开链接都在那里）。
        h.itemView.setOnClickListener(v ->
                v.getContext().startActivity(MessageDetailActivity.intentFor(v.getContext(), m)));
    }

    private static String clip(String s, int max) {
        if (s == null) return "";
        if (s.length() <= max) return s;
        return s.substring(0, max) + "…";
    }

    private String fmt(long ts) {
        Date d = new Date(ts);
        Calendar now = Calendar.getInstance();
        Calendar then = Calendar.getInstance();
        then.setTime(d);
        boolean sameDay = now.get(Calendar.YEAR) == then.get(Calendar.YEAR)
                && now.get(Calendar.DAY_OF_YEAR) == then.get(Calendar.DAY_OF_YEAR);
        return sameDay ? todayFmt.format(d) : oldFmt.format(d);
    }

    @Override
    public int getItemCount() {
        return items.size();
    }

    static class VH extends RecyclerView.ViewHolder {
        final View sourceDot;
        final TextView sourceName;
        final TextView priorityChip;
        final TextView time;
        final TextView title;
        final TextView body;
        final TextView attachmentBadge;
        final TextView fullHint;

        VH(View v) {
            super(v);
            sourceDot = v.findViewById(R.id.sourceDot);
            sourceName = v.findViewById(R.id.sourceName);
            priorityChip = v.findViewById(R.id.priorityChip);
            time = v.findViewById(R.id.timeText);
            title = v.findViewById(R.id.titleText);
            body = v.findViewById(R.id.bodyText);
            attachmentBadge = v.findViewById(R.id.attachmentBadge);
            fullHint = v.findViewById(R.id.fullHint);
        }
    }
}