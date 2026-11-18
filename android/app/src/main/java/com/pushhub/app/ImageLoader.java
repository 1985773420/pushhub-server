package com.pushhub.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;
import android.widget.ImageView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 很小的图片加载器：内存 LRU + 线程池，避免为几张附件图引入完整图片库。 */
public final class ImageLoader {
    private static final ExecutorService POOL = Executors.newFixedThreadPool(3);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final int MAX_BYTES = 15 * 1024 * 1024;
    private static final LruCache<String, Bitmap> CACHE;

    static {
        int maxKb = (int) (Runtime.getRuntime().maxMemory() / 1024 / 8);
        CACHE = new LruCache<String, Bitmap>(maxKb) {
            @Override
            protected int sizeOf(String key, Bitmap value) {
                return value.getByteCount() / 1024;
            }
        };
    }

    private ImageLoader() {
    }

    public static void load(ImageView view, String url) {
        if (view == null || url == null || url.isEmpty()) return;
        Bitmap cached = CACHE.get(url);
        if (cached != null) {
            view.setImageBitmap(cached);
            view.setTag(url);
            return;
        }
        view.setTag(url);
        view.setImageDrawable(null);
        POOL.execute(() -> {
            Bitmap bm = loadSync(url, 1440);
            if (bm == null) return;
            MAIN.post(() -> {
                if (url.equals(view.getTag())) view.setImageBitmap(bm);
            });
        });
    }

    /** 同步加载并缩放到最长边 maxPx 的 RGB_565 图，供通知大图使用。 */
    public static Bitmap loadSync(String url, int maxPx) {
        HttpURLConnection conn = null;
        try {
            if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(12000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "PushHub-Android");
            if (conn.getResponseCode() != 200) return null;
            byte[] data;
            try (InputStream is = conn.getInputStream()) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) {
                    if (bos.size() + n > MAX_BYTES) return null;
                    bos.write(buf, 0, n);
                }
                data = bos.toByteArray();
            }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
            int sample = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / sample > maxPx * 2) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            opts.inPreferredConfig = Bitmap.Config.RGB_565;
            Bitmap bm = BitmapFactory.decodeByteArray(data, 0, data.length, opts);
            if (bm == null) return null;
            CACHE.put(url, bm);
            return bm;
        } catch (Exception ignored) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}