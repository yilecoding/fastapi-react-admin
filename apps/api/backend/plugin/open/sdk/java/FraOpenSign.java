// 开放接口签名（FRA1-HMAC-SHA256）—— Java 参考实现（JDK 11+，只用标准库），可以整个文件拷走。
//
//   String url = "https://admin.example.com/api/open/v1/users?limit=500";
//   Map<String, String> headers = FraOpenSign.signHeaders("GET", url, new byte[0], "fra_ak_…", "fra_sk_…", null, null);
//   HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url));
//   headers.forEach(b::header);
//
// 🔴 请求体要签**实际发出去的那串字节**：先序列化成 byte[]、签它、再用 BodyPublishers.ofByteArray 原样发。

import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class FraOpenSign {
    private FraOpenSign() {}

    // URLEncoder 是表单编码：空格变 +、~ 被编码。改成 RFC 3986
    static String encode(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8)
                .replace("+", "%20")
                .replace("*", "%2A")
                .replace("%7E", "~");
    }

    public static String canonicalQuery(String rawQuery) {
        if (rawQuery == null || rawQuery.isEmpty()) return "";
        List<String[]> pairs = new ArrayList<>();
        for (String kv : rawQuery.split("&")) {
            if (kv.isEmpty()) continue;
            int i = kv.indexOf('=');
            String k = i < 0 ? kv : kv.substring(0, i);
            String v = i < 0 ? "" : kv.substring(i + 1);
            // URLDecoder 把 + 当空格，和服务端一致
            pairs.add(new String[] {
                encode(URLDecoder.decode(k, StandardCharsets.UTF_8)),
                encode(URLDecoder.decode(v, StandardCharsets.UTF_8)),
            });
        }
        pairs.sort((a, b) -> a[0].equals(b[0]) ? a[1].compareTo(b[1]) : a[0].compareTo(b[0]));
        StringBuilder sb = new StringBuilder();
        for (String[] p : pairs) {
            if (sb.length() > 0) sb.append('&');
            sb.append(p[0]).append('=').append(p[1]);
        }
        return sb.toString();
    }

    static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    public static String stringToSign(String method, String url, byte[] body, String timestamp, String nonce) throws Exception {
        URI u = URI.create(url);
        String path = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
        String bodyHash = hex(MessageDigest.getInstance("SHA-256").digest(body == null ? new byte[0] : body));
        return String.join("\n", method.toUpperCase(), path, canonicalQuery(u.getRawQuery()), timestamp, nonce, bodyHash);
    }

    public static Map<String, String> signHeaders(
            String method, String url, byte[] body, String accessKey, String secretKey, String timestamp, String nonce)
            throws Exception {
        String ts = timestamp != null ? timestamp : String.valueOf(System.currentTimeMillis());
        String n = nonce != null ? nonce : UUID.randomUUID().toString().replace("-", "");
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secretKey.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String sign = hex(mac.doFinal(stringToSign(method, url, body, ts, n).getBytes(StandardCharsets.UTF_8)));
        Map<String, String> h = new LinkedHashMap<>();
        h.put("X-Access-Key", accessKey);
        h.put("X-Timestamp", ts);
        h.put("X-Nonce", n);
        h.put("X-Sign", sign);
        return h;
    }
}
