package com.filmx.player;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

/**
 * Tam ekran native oynatıcı. Bir embed/oynatıcı URL'sini ÜST DÜZEY (iframe değil)
 * yükler -> X-Frame-Options konu dışı kalır. Ayrıca:
 *  - Referer/UA doğru gönderilir (loadUrl başlığı + alt-frame yeniden servis)
 *  - alt-frame HTML dokümanlarında X-Frame-Options / CSP silinir + frame-bust kırıcı enjekte
 *  - reklam/popup domainleri boş cevapla engellenir
 *  - HTML5 tam ekran (onShowCustomView) + yatay destek
 */
public class PlayerActivity extends Activity {

    private WebView web;
    private FrameLayout root;
    private View customView;
    private WebChromeClient.CustomViewCallback customCb;

    private String referer = "";

    // reklam/popup/istatistik domainleri (istekleri boş 200 ile kesilir)
    static final String[] AD_HOSTS = {
        "doubleclick.net", "googlesyndication.com", "google-analytics.com",
        "googletagmanager.com", "googletagservices.com", "adservice.google",
        "popads", "popcash", "propellerads", "propeller", "onclickads",
        "adnxs.com", "adsterra", "hilltopads", "exoclick", "juicyads",
        "poweredby.jads", "mgid.com", "yandex.ru/ads", "histats", "clarity.ms",
        "/ads/", "adskeeper", "outbrain", "taboola", "pushnotif", "onesignal"
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                             WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setLayoutParams(new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        String url = getIntent().getStringExtra("url");
        referer = getIntent().getStringExtra("referer");
        if (referer == null) referer = "";

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(MainActivity.UA);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setBuiltInZoomControls(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return intercept(r);
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String u = r.getUrl().toString();
                // reklam yönlendirmelerini/harici uygulama linklerini engelle
                if (isAd(u)) return true;
                if (!u.startsWith("http")) return true;
                return false;
            }
            @Override
            public void onPageFinished(WebView v, String u) {
                v.evaluateJavascript(CLEANUP_JS, null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                if (customView != null) { cb.onCustomViewHidden(); return; }
                customView = view;
                customCb = cb;
                web.setVisibility(View.GONE);
                root.addView(customView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                hideSystemUi();
            }
            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                if (customCb != null) customCb.onCustomViewHidden();
                web.setVisibility(View.VISIBLE);
            }
        });

        Map<String, String> h = new HashMap<>();
        if (referer.length() > 0) h.put("Referer", referer);
        web.loadUrl(url, h);
    }

    /* reklam mı? */
    static boolean isAdStatic(String u) {
        String low = u.toLowerCase();
        for (String a : AD_HOSTS) if (low.contains(a)) return true;
        return false;
    }
    boolean isAd(String u) { return isAdStatic(u); }

    /* İstek yakalama: reklam kes, alt-frame HTML'de header sıyır + frame-bust kır */
    WebResourceResponse intercept(WebResourceRequest r) {
        try {
            String u = r.getUrl().toString();
            if (isAd(u)) {
                return new WebResourceResponse("text/plain", "utf-8",
                    new ByteArrayInputStream(new byte[0]));
            }
            if (!"GET".equalsIgnoreCase(r.getMethod())) return null;
            String accept = r.getRequestHeaders().get("Accept");
            boolean htmlDoc = accept != null && accept.contains("text/html");
            // Sadece iframe (alt-frame) HTML dokümanlarını yeniden servis et
            if (htmlDoc && !r.isForMainFrame()) {
                return reserveStripped(u, r.getRequestHeaders());
            }
            return null; // medya/segment/xhr -> native geçsin (range destekli, hızlı)
        } catch (Exception e) {
            return null;
        }
    }

    /* Alt-frame dokümanını çek, X-Frame/CSP sil, frame-bust kırıcı enjekte et */
    WebResourceResponse reserveStripped(String url, Map<String, String> reqHeaders) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            for (Map.Entry<String, String> e : reqHeaders.entrySet()) {
                if (e.getKey().equalsIgnoreCase("Accept-Encoding")) continue;
                c.setRequestProperty(e.getKey(), e.getValue());
            }
            c.setRequestProperty("User-Agent", MainActivity.UA);
            if (reqHeaders.get("Referer") == null && referer.length() > 0)
                c.setRequestProperty("Referer", referer);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) c.setRequestProperty("Cookie", cookies);
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(12000);
            c.setReadTimeout(15000);
            int code = c.getResponseCode();
            String ct = c.getContentType();
            if (ct == null) ct = "text/html";
            String mime = ct.split(";")[0].trim();
            if (!mime.contains("html")) { c.disconnect(); return null; }

            InputStream in = (code >= 200 && code < 400) ? c.getInputStream() : c.getErrorStream();
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = in.read(buf)) != -1) bo.write(buf, 0, n);
            c.disconnect();

            String html = new String(bo.toByteArray(), "UTF-8");
            // frame-bust kırıcıyı en başa enjekte et
            String inject = "<script>try{window.open=function(){return null;};"
                + "window.onbeforeunload=null;"
                + "Object.defineProperty(document,'referrer',{get:function(){return '" + referer + "';}});"
                + "}catch(e){}</script>";
            int hi = html.toLowerCase().indexOf("<head");
            if (hi >= 0) {
                int close = html.indexOf('>', hi);
                if (close >= 0) html = html.substring(0, close + 1) + inject + html.substring(close + 1);
            } else {
                html = inject + html;
            }
            InputStream out = new ByteArrayInputStream(html.getBytes("UTF-8"));
            Map<String, String> respH = new HashMap<>();
            respH.put("Access-Control-Allow-Origin", "*");
            WebResourceResponse resp = new WebResourceResponse("text/html", "UTF-8", out);
            resp.setResponseHeaders(respH); // X-Frame-Options / CSP verilmedi -> silinmiş olur
            return resp;
        } catch (Exception e) {
            return null;
        }
    }

    void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            web.getWebChromeClient().onHideCustomView();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
        }
        super.onDestroy();
    }

    /* Oynatıcı sayfasında reklam/overlay temizliği + video'yu öne çıkar */
    static final String CLEANUP_JS =
        "(function(){try{"
      + "var kill=['.ad','.ads','#ad','.reklam','.popup','.overlay-ad','ins','iframe[src*=ads]'];"
      + "document.querySelectorAll('a[target=_blank]').forEach(function(a){a.removeAttribute('target');});"
      + "var vs=document.getElementsByTagName('video');"
      + "if(vs.length){var v=vs[0];v.setAttribute('playsinline','');v.style.width='100%';v.style.height='100%';}"
      + "}catch(e){}})();";
}
