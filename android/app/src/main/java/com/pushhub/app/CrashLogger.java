package com.pushhub.app;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** 把未捕获异常写到 filesDir/last-crash.txt，下次打开 App 可复制出来排查。 */
public final class CrashLogger {
    private static final String TAG = "PushHub.Crash";
    private static final String FILE = "last-crash.txt";

    private CrashLogger() {
    }

    public static void install() {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, e) -> {
            try {
                Context ctx = App.ctx();
                if (ctx != null) {
                    StringWriter sw = new StringWriter();
                    e.printStackTrace(new PrintWriter(sw));
                    String text = "time=" + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(new Date()) + "\n"
                            + "version=" + BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")\n"
                            + "device=" + Build.MANUFACTURER + " " + Build.MODEL + "\n"
                            + "android=" + Build.VERSION.RELEASE + " (sdk " + Build.VERSION.SDK_INT + ")\n"
                            + "thread=" + thread.getName() + "\n\n" + sw;
                    try (FileOutputStream fos = new FileOutputStream(new File(ctx.getFilesDir(), FILE))) {
                        fos.write(text.getBytes(StandardCharsets.UTF_8));
                    }
                }
                Log.e(TAG, "uncaught exception", e);
            } catch (Throwable ignored) {
            }
            if (prev != null) prev.uncaughtException(thread, e);
        });
    }

    public static String read(Context ctx) {
        File f = new File(ctx.getFilesDir(), FILE);
        if (!f.exists()) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    public static void clear(Context ctx) {
        try {
            new File(ctx.getFilesDir(), FILE).delete();
        } catch (Exception ignored) {
        }
    }
}
