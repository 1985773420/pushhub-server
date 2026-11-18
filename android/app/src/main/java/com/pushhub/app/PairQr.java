package com.pushhub.app;

import org.json.JSONObject;
import java.net.URI;

public final class PairQr {
    public static String[] parse(String text) throws Exception {
        if (text == null || text.length() > 2048) throw new IllegalArgumentException();
        JSONObject data = new JSONObject(text);
        if (data.length() != 2 || !data.has("server") || !data.has("code")) throw new IllegalArgumentException();
        String server = data.getString("server");
        URI uri = new URI(server);
        if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) throw new IllegalArgumentException();
        String code = data.getString("code").toUpperCase(java.util.Locale.ROOT);
        if (!code.matches("[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}")) throw new IllegalArgumentException();
        return new String[]{server, code};
    }
}
