package com.filmx.player;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.ConsoleMessage;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * FilmX ana ekran. Kendi arayüzümüzü (app.html) çevrimdışı yükler.
 * İki köprü sağlar:
 *   FilmXNet.fetch(reqId, url, referer)  -> CORS'suz native HTTP (kaynak siteleri tarar)
 *   FilmXPlayer.open(embedUrl, referer, title) -> tam ekran native oynatıcı
 */
public class MainActivity extends Activity {

    static final String UA =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) "
        + "Chrome/125.0.0.0 Mobile Safari/537.36";

    private WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(6);

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(0xFF0B0D13);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(UA);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new NetBridge(), "FilmXNet");
        web.addJavascriptInterface(new PlayerBridge(), "FilmXPlayer");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                // Uygulama içi arayüz; dış linkleri native oynatıcıya yönlendir yok, engelle
                String u = r.getUrl().toString();
                if (u.startsWith("file://")) return false;
                return true; // dış navigasyonu bloke et (UI tek sayfa)
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                android.util.Log.d("FilmX-UI", m.message() + " @" + m.lineNumber());
                return true;
            }
        });

        web.loadUrl("file:///android_asset/app.html");
    }

    /* ---------------- NET KÖPRÜSÜ: CORS'suz kaynak site tarama ---------------- */
    class NetBridge {
        @JavascriptInterface
        public void fetch(final String reqId, final String url, final String referer) {
            pool.execute(() -> {
                int status = 0;
                String body = "";
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestProperty("User-Agent", UA);
                    c.setRequestProperty("Accept",
                        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
                    c.setRequestProperty("Accept-Language", "tr-TR,tr;q=0.9,en;q=0.8");
                    if (referer != null && referer.length() > 0)
                        c.setRequestProperty("Referer", referer);
                    String cookies = CookieManager.getInstance().getCookie(url);
                    if (cookies != null && cookies.length() > 0)
                        c.setRequestProperty("Cookie", cookies);
                    c.setInstanceFollowRedirects(true);
                    c.setConnectTimeout(12000);
                    c.setReadTimeout(12000);
                    status = c.getResponseCode();
                    InputStream in = (status >= 200 && status < 400)
                        ? c.getInputStream() : c.getErrorStream();
                    if (in != null) {
                        ByteArrayOutputStream bo = new ByteArrayOutputStream();
                        byte[] buf = new byte[8192];
                        int n;
                        BufferedInputStream bin = new BufferedInputStream(in);
                        while ((n = bin.read(buf)) != -1) bo.write(buf, 0, n);
                        body = new String(bo.toByteArray(), "UTF-8");
                    }
                    // set-cookie sakla
                    String sc = c.getHeaderField("Set-Cookie");
                    if (sc != null) CookieManager.getInstance().setCookie(url, sc);
                    c.disconnect();
                } catch (Exception e) {
                    body = "ERR:" + e.getMessage();
                }
                deliver(reqId, status, body);
            });
        }

        private void deliver(String reqId, int status, String body) {
            String b64 = Base64.encodeToString(body.getBytes(), Base64.NO_WRAP);
            final String js = "window.__filmxNet && window.__filmxNet('" + reqId + "',"
                + status + ",'" + b64 + "')";
            runOnUiThread(() -> web.evaluateJavascript(js, null));
        }
    }

    /* ---------------- OYNATICI KÖPRÜSÜ ---------------- */
    class PlayerBridge {
        @JavascriptInterface
        public void open(String embedUrl, String referer, String title) {
            Intent i = new Intent(MainActivity.this, PlayerActivity.class);
            i.putExtra("url", embedUrl);
            i.putExtra("referer", referer == null ? "" : referer);
            i.putExtra("title", title == null ? "" : title);
            startActivity(i);
        }
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            // Once app.html'e sor: detay/oynatıcı açıksa onu kapat
            web.evaluateJavascript(
                "(window.onFilmXBack&&window.onFilmXBack())?'1':'0'",
                new android.webkit.ValueCallback<String>() {
                    @Override public void onReceiveValue(String v) {
                        if (!"\"1\"".equals(v)) moveTaskToBack(true);
                    }
                });
            return true;
        }
        return super.onKeyDown(code, e);
    }
}
