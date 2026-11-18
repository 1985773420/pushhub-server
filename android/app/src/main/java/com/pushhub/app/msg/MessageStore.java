package com.pushhub.app.msg;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import com.pushhub.app.App;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** Durable history. All database operations are serialized, including notification claims. */
public final class MessageStore {
    private static final List<Runnable> LISTENERS = new CopyOnWriteArrayList<>();
    private static SQLiteOpenHelper helper;
    private static long generation;
    private MessageStore() {}

    public static synchronized void initialize() { db(); }

    private static SQLiteDatabase db() {
        if (helper == null) helper = new SQLiteOpenHelper(App.ctx(), "history.db", null, 2) {
            @Override public void onCreate(SQLiteDatabase db) {
                db.execSQL("CREATE TABLE messages (key TEXT PRIMARY KEY, id TEXT, source TEXT, title TEXT, body TEXT, url TEXT, ts INTEGER, priority TEXT, received INTEGER NOT NULL DEFAULT 0, attachments TEXT)");
                db.execSQL("CREATE INDEX messages_time ON messages(ts DESC)");
            }
            @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
                if (oldVersion < 2) db.execSQL("ALTER TABLE messages ADD COLUMN attachments TEXT");
            }
        };
        return helper.getWritableDatabase();
    }
    private static String key(MessageItem m) {
        // Missing IDs must not collapse unrelated messages.
        return m.source + "\n" + (m.id == null || m.id.isEmpty()
                ? "fallback:" + m.ts + ":" + m.title + ":" + m.body + ":" + m.url : "id:" + m.id);
    }
    private static boolean put(MessageItem m, boolean received) {
        SQLiteDatabase db = db();
        ContentValues v = new ContentValues();
        v.put("key", key(m)); v.put("id", m.id); v.put("source", m.source);
        v.put("title", m.title); v.put("body", m.body); v.put("url", m.url);
        v.put("ts", m.ts); v.put("priority", m.priority); v.put("received", received ? 1 : 0);
        v.put("attachments", m.attachmentsJson());
        if (db.insertWithOnConflict("messages", null, v, SQLiteDatabase.CONFLICT_IGNORE) != -1) return true;
        if (!received) return false;
        ContentValues claim = new ContentValues(); claim.put("received", 1);
        return db.update("messages", claim, "key=? AND received=0", new String[]{key(m)}) > 0;
    }
    public static void add(MessageItem m) { addAll(java.util.Collections.singletonList(m)); }
    public static void addAll(List<MessageItem> items) {
        synchronized (MessageStore.class) { write(items, false); }
        fire();
    }
    public static synchronized long generation() { return generation; }
    public static void addAll(List<MessageItem> items, long expected) {
        synchronized (MessageStore.class) {
            if (generation != expected) return;
            write(items, false);
        }
        fire();
    }
    private static List<MessageItem> write(List<MessageItem> items, boolean received) {
        List<MessageItem> fresh = new ArrayList<>();
        SQLiteDatabase db = db(); db.beginTransaction();
        try {
            for (MessageItem m : items) if (put(m, received)) fresh.add(m);
            db.execSQL("DELETE FROM messages WHERE rowid IN (SELECT rowid FROM messages ORDER BY ts DESC, rowid DESC LIMIT -1 OFFSET 10000)");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        return fresh;
    }
    /** Save the entire batch before ACK; persistent claims suppress reconnect/restart duplicates. */
    public static List<MessageItem> receive(List<MessageItem> items) {
        List<MessageItem> fresh;
        synchronized (MessageStore.class) { fresh = write(items, true); }
        fire(); return fresh;
    }
    public static synchronized MessageItem find(String id) {
        try (Cursor c = db().query("messages", null, "id=?", new String[]{id}, null, null, "ts DESC", "1")) {
            return c.moveToFirst() ? item(c) : null;
        }
    }
    public static List<MessageItem> snapshot() { return search("", null); }
    public static synchronized List<MessageItem> search(String text, String source) {
        String where = "(instr(lower(coalesce(title,'')),lower(?))>0 OR instr(lower(coalesce(body,'')),lower(?))>0)";
        List<String> args = new ArrayList<>(); args.add(text); args.add(text);
        if (source != null) { where += " AND source=?"; args.add(source); }
        List<MessageItem> result = new ArrayList<>();
        try (Cursor c = db().query("messages", null, where, args.toArray(new String[0]), null, null, "ts DESC, rowid DESC", "500")) {
            while (c.moveToNext()) result.add(item(c));
        }
        return result;
    }
    public static synchronized List<String> sources() {
        List<String> result = new ArrayList<>();
        try (Cursor c = db().rawQuery("SELECT DISTINCT source FROM messages ORDER BY source", null)) {
            while(c.moveToNext()) result.add(c.getString(0));
        }
        return result;
    }
    private static MessageItem item(Cursor c) {
        int ai = c.getColumnIndex("attachments");
        String stored = ai >= 0 && !c.isNull(ai) ? c.getString(ai) : null;
        return new MessageItem(c.getString(1), c.getString(2), c.getString(3), c.getString(4), c.getString(5), c.getLong(6), c.getString(7), MessageItem.parseStored(stored));
    }
    public static void clear() {
        synchronized (MessageStore.class) { generation++; db().delete("messages", null, null); }
        fire();
    }
    private static void fire() { for (Runnable r : LISTENERS) r.run(); }
    public static void watch(Runnable r) { LISTENERS.add(r); }
    public static void unwatch(Runnable r) { LISTENERS.remove(r); }
}
