package com.pushhub.app.ws;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * 一个极简但完整的 RFC6455 WebSocket 客户端（文本帧），零第三方依赖。
 * 服务端是我们的 pushhub-server（ws 库），不支持的行为可以适当宽限。
 */
public final class WsClient {
    public interface Callback {
        void onOpen(WsClient client);

        /** 完整文本消息（已按 continuation 帧重组）。 */
        void onMessage(WsClient client, String text);

        /** 连接关闭。code=1006 表示异常断开。 */
        void onClose(WsClient client, int code, String reason);

        void onError(WsClient client, Exception e);
    }

    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final SecureRandom RAND = new SecureRandom();

    private final URI uri;
    private final Callback cb;
    private final int idleTimeoutMs;

    private Socket socket;
    private InputStream in;
    private OutputStream out;
    private volatile Thread reader;
    private volatile boolean closed = true;
    private final Object writeLock = new Object();
    private StringBuilder pendingText; // continuation 帧重组用（reader 线程独占）

    public WsClient(String url, Callback cb, int idleTimeoutMs) {
        this.uri = URI.create(url);
        this.cb = cb;
        this.idleTimeoutMs = idleTimeoutMs;
    }

    public boolean isOpen() {
        return !closed && socket != null && !socket.isClosed();
    }

    /** 异步连接，成功/失败都会通过回调返回。 */
    public void connect() {
        if (!closed) close(1000, "reconnect");
        closed = false;
        pendingText = null;
        Thread t = new Thread(this::runConnect, "ws-connect");
        t.setDaemon(true);
        reader = t;
        t.start();
    }

    private void runConnect() {
        try {
            URI u = uri;
            String host = u.getHost();
            int port = u.getPort();
            if (port < 0) port = "wss".equalsIgnoreCase(u.getScheme()) ? 443 : 80;

            if ("wss".equalsIgnoreCase(u.getScheme())) {
                SSLSocket ssl = (SSLSocket) SSLSocketFactory.getDefault().createSocket();
                ssl.connect(new java.net.InetSocketAddress(host, port), 10_000);
                ssl.setSoTimeout(idleTimeoutMs);
                ssl.startHandshake();
                if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ssl.getSession())) {
                    ssl.close();
                    throw new IOException("证书与服务器域名不匹配: " + host);
                }
                socket = ssl;
            } else {
                Socket s = new Socket();
                s.connect(new java.net.InetSocketAddress(host, port), 10_000);
                s.setSoTimeout(idleTimeoutMs);
                s.setKeepAlive(true);
                socket = s;
            }
            socket.setTcpNoDelay(true);
            in = new BufferedInputStream(socket.getInputStream(), 8192);
            out = socket.getOutputStream();

            handshake(u, host, port);

            if (closed) {
                quietlyClose();
                return;
            }
            try {
                cb.onOpen(this);
            } catch (Exception ignored) {
            }
            readLoop();
        } catch (Exception e) {
            if (closed) return;
            closed = true;
            quietlyClose();
            try {
                cb.onError(this, e);
                cb.onClose(this, 1006, e.getMessage() == null ? e.toString() : e.getMessage());
            } catch (Exception ignored) {
            }
        }
    }

    private void handshake(URI u, String host, int port) throws IOException {
        String path = u.getRawPath();
        if (path == null || path.isEmpty()) path = "/";
        if (u.getRawQuery() != null) path += "?" + u.getRawQuery();

        byte[] nonce = new byte[16];
        RAND.nextBytes(nonce);
        String key = Base64.getEncoder().encodeToString(nonce);

        StringBuilder req = new StringBuilder();
        req.append("GET ").append(path).append(" HTTP/1.1\r\n");
        req.append("Host: ").append(host);
        if (port != 80 && port != 443) req.append(":").append(port);
        req.append("\r\n")
                .append("Upgrade: websocket\r\n")
                .append("Connection: upgrade\r\n")
                .append("Sec-WebSocket-Key: ").append(key).append("\r\n")
                .append("Sec-WebSocket-Version: 13\r\n")
                .append("\r\n");
        out.write(req.toString().getBytes(StandardCharsets.ISO_8859_1));
        out.flush();

        // HTTP 响应行 + 头
        String statusLine = readLine();
        String[] parts = statusLine.split(" ");
        if (parts.length < 2 || !"101".equals(parts[1])) {
            throw new IOException("WebSocket 升级失败: " + statusLine + " (" + caseBody() + ")");
        }
        String accept = null;
        String line;
        while (!(line = readLine()).isEmpty()) {
            int c = line.indexOf(':');
            if (c < 0) continue;
            String name = line.substring(0, c).trim().toLowerCase();
            String value = line.substring(c + 1).trim();
            if ("sec-websocket-accept".equals(name)) accept = value;
        }
        if (accept == null) throw new IOException("缺少 Sec-WebSocket-Accept");
        String expect;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            expect = Base64.getEncoder().encodeToString(md.digest((key + GUID).getBytes(StandardCharsets.ISO_8859_1)));
        } catch (Exception e) {
            throw new IOException("SHA-1 不可用", e);
        }
        if (!expect.equals(accept)) throw new IOException("Sec-WebSocket-Accept 校验失败");
    }

    private String caseBody() {
        try {
            socket.setSoTimeout(1500);
            byte[] buf = new byte[256];
            int n = in.read(buf);
            return n > 0 ? new String(buf, 0, n).trim() : "(no body)";
        } catch (Exception e) {
            return "(no body)";
        }
    }

    private String readLine() throws IOException {
        StringBuilder sb = new StringBuilder(64);
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') {
                int len = sb.length();
                if (len > 0 && sb.charAt(len - 1) == '\r') sb.setLength(len - 1);
                return sb.toString();
            }
            sb.append((char) b);
        }
        throw new IOException("连接在读取响应时被关闭");
    }

    private void readLoop() throws IOException {
        while (!closed) {
            // 帧头
            int b1 = in.read();
            if (b1 < 0) throw new IOException("连接被对端关闭");
            int b2 = in.read();
            boolean fin = (b1 & 0x80) != 0;
            int opcode = b1 & 0x0F;
            boolean masked = (b2 & 0x80) != 0;
            long len = b2 & 0x7F;
            if (len == 126) {
                len = ((long) in.read() << 8) | in.read();
            } else if (len == 127) {
                len = readLong64();
            }
            if (len > 16 * 1024 * 1024) throw new IOException("帧过大: " + len);
            byte[] mask = null;
            if (masked) {
                mask = new byte[4];
                readFully(mask);
            }
            byte[] payload = len == 0 ? new byte[0] : new byte[(int) len];
            if (len > 0) readFully(payload);
            if (masked) {
                for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            }

            switch (opcode) {
                case 0x0: // continuation
                    if (pendingText == null) pendingText = new StringBuilder();
                    pendingText.append(new String(payload, StandardCharsets.UTF_8));
                    if (fin) {
                        String text = pendingText.toString();
                        pendingText = null;
                        dispatch(text);
                    }
                    break;
                case 0x1: { // text
                    String text = new String(payload, StandardCharsets.UTF_8);
                    if (!fin) {
                        pendingText = new StringBuilder(text);
                    } else {
                        dispatch(text);
                    }
                    break;
                }
                case 0x2: // binary：忽略
                    break;
                case 0x8: { // close
                    int code = 1005;
                    String reason = "";
                    if (payload.length >= 2) {
                        code = ((payload[0] & 0xFF) << 8) | (payload[1] & 0xFF);
                        if (payload.length > 2) reason = new String(payload, 2, payload.length - 2, StandardCharsets.UTF_8);
                    }
                    try {
                        sendFrame(0x8, new byte[0]); // 回一个 close
                    } catch (Exception ignored) {
                    }
                    closed = true;
                    quietlyClose();
                    cb.onClose(this, code, reason);
                    return;
                }
                case 0x9: // ping -> pong
                    try {
                        sendFrame(0xA, payload);
                    } catch (Exception ignored) {
                    }
                    break;
                case 0xA: // pong
                    break;
                default:
                    break;
            }
        }
    }

    private void dispatch(String text) {
        try {
            if (!closed) cb.onMessage(this, text);
        } catch (Exception ignored) {
        }
    }

    private long readLong64() throws IOException {
        long v = 0;
        for (int i = 0; i < 8; i++) {
            int b = in.read();
            if (b < 0) throw new IOException("连接被对端关闭");
            v = (v << 8) | b;
        }
        return v;
    }

    private void readFully(byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) throw new IOException("连接被对端关闭");
            off += n;
        }
    }

    /** 发送文本帧（客户端必须掩码）。 */
    public boolean sendText(String text) {
        if (closed || out == null) return false;
        byte[] payload = text.getBytes(StandardCharsets.UTF_8);
        try {
            synchronized (writeLock) {
                sendFrame(0x1, payload);
            }
            return true;
        } catch (Exception e) {
            handleWriteError(e);
            return false;
        }
    }

    private void handleWriteError(Exception e) {
        if (closed) return;
        closed = true;
        quietlyClose();
        try {
            cb.onError(this, e);
            cb.onClose(this, 1006, e.getMessage());
        } catch (Exception ignored) {
        }
    }

    private void sendFrame(int opcode, byte[] payload) throws IOException {
        byte[] header;
        int len = payload.length;
        if (len < 126) {
            header = new byte[2 + 4];
            header[1] = (byte) (0x80 | len);
        } else if (len <= 0xFFFF) {
            header = new byte[4 + 4];
            header[1] = (byte) (0x80 | 126);
            header[2] = (byte) (len >> 8);
            header[3] = (byte) len;
        } else {
            header = new byte[10 + 4];
            header[1] = (byte) (0x80 | 127);
            long l = len;
            for (int i = 8; i >= 1; i--) {
                header[i + 1] = (byte) (l & 0xFF);
                l >>= 8;
            }
        }
        header[0] = (byte) (0x80 | opcode);
        byte[] mask = new byte[4];
        RAND.nextBytes(mask);
        System.arraycopy(mask, 0, header, header.length - 4, 4);
        synchronized (writeLock) {
            out.write(header);
            if (len > 0) {
                byte[] masked = new byte[len];
                for (int i = 0; i < len; i++) masked[i] = (byte) (payload[i] ^ mask[i & 3]);
                out.write(masked);
            }
            out.flush();
        }
    }

    /** 主动关闭。 */
    public void close(int code, String reason) {
        if (closed) return;
        try {
            if (out != null) {
                byte[] payload = new byte[2];
                payload[0] = (byte) (code >> 8);
                payload[1] = (byte) code;
                synchronized (writeLock) {
                    out.write(new byte[]{(byte) 0x88, (byte) (0x80 | payload.length)});
                    byte[] mask = new byte[4];
                    RAND.nextBytes(mask);
                    out.write(mask);
                    for (int i = 0; i < payload.length; i++) out.write(payload[i] ^ mask[i & 3]);
                    out.flush();
                }
            }
        } catch (Exception ignored) {
        }
        closed = true;
        quietlyClose();
    }

    private void quietlyClose() {
        try {
            if (socket != null) socket.close();
        } catch (Exception ignored) {
        }
    }
}