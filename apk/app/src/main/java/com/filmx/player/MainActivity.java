package com.filmx.player;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.graphics.Insets;
import android.os.Build;
import android.view.WindowInsets;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * FilmX uygulaması (kişisel kullanım).
 *
 *   - Site (index.html + resimler + filmx.mp3) APK'nın içinde: assets/site/ (derle.py kopyalar).
 *     https://appassets.androidplatform.net/site/index.html adresinden sunulur; YouTube gömülü oynatıcısı
 *     file:// sayfada oynamadığı için gerçek bir https adresi şart. Giriş sunucusu bu adrese izin verir.
 *   - Reklam engelleme (Desktop/adblock projesinden):
 *       1) EasyList + EasyPrivacy ile ağ engelleme (FiltreMotoru) — tüm oynatıcılarda
 *       2) YouTube oynatıcısına reklam bilgisi ulaşmadan silinir (assets/reklamsiz.js, belge başında) — YALNIZ kurucu hesapta
 *       3) Açılır pencereler ve siteden dışarı yönlendirmeler engellenir
 *   - Zorunlu güncelleme: Guncelleme.java (Netlify surum.json)
 */
public class MainActivity extends Activity {

    static final String ALAN = "appassets.androidplatform.net";
    static final String ANA_ADRES = "https://" + ALAN + "/site/index.html";

    /** Bunlardan biri kesilirse video hiç açılmaz: engel listesine takılsa bile dokunulmaz. */
    static final String[] DOKUNMA = {
        "googlevideo.com", "ytimg.com", "ggpht.com", "jnn-pa.googleapis.com", "youtubei.googleapis.com",
        "workers.dev"
    };
    /** YouTube reklam betiğinin çalışacağı çerçeveler. */
    static final String[] YOUTUBE = {
        "https://www.youtube-nocookie.com", "https://youtube-nocookie.com",
        "https://www.youtube.com", "https://youtube.com", "https://m.youtube.com"
    };

    private WebView web;
    private FrameLayout kok;
    private View tamEkran;
    private WebChromeClient.CustomViewCallback tamEkranGeri;
    private WebViewAssetLoader yukleyici;
    private final FiltreMotoru motor = new FiltreMotoru();
    private String reklamsizKod = "";
    private Guncelleme guncelleme;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        kok = new FrameLayout(this);
        kok.setBackgroundColor(Color.BLACK);
        setContentView(kok);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);   // her sürümde aynı: boşlukları biz veririz
        kenarBosluklari();

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        kok.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // açılış müziği
        s.setLoadWithOverviewMode(false);              // sayfa küçültülüp sığdırılmasın; site kendi mobil düzenini kullanır
        s.setTextZoom(100);                             // telefonun yazı boyutu ayarı (Samsung) sayfayı büyütüp taşırmasın
        s.setUseWideViewPort(true);
        s.setSupportMultipleWindows(true);              // window.open -> onCreateWindow'da reddedilir (açılır pencere yok)
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // "; wv" işareti bazı oynatıcıların uygulama içi görünümü engellemesine yol açıyor
        s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        yukleyici = new WebViewAssetLoader.Builder()
            .setDomain(ALAN)
            .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();

        reklamsizKod = assetOku("reklamsiz.js");
        sahipDinle();

        new Thread(this::listeleriYukle, "filtre-yukle").start();
        istemciler();
        guncelleme = new Guncelleme(this, kok, assetOku("guncelleme.txt"));
        web.loadUrl(ANA_ADRES);
    }

    /* ---------- YouTube reklamsız: yalnız kurucu (sahip) hesap giriş yapınca ----------
       Site giriş kontrolünden sonra FilmXApp.postMessage('sahip:1' | 'sahip:0') gönderir.
       Mesaj yalnız sitenin kendi adresinden kabul edilir (iframe'lerdeki başka siteler gönderemez). */
    private boolean sahip = false;
    private ScriptHandler reklamsizBetik;

    private void sahipDinle() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        Set<String> izin = new HashSet<>();
        izin.add("https://" + ALAN);
        WebViewCompat.addWebMessageListener(web, "FilmXApp", izin, (v, mesaj, kaynak, anaCerceve, cevap) -> {
            if (!anaCerceve || mesaj.getData() == null) return;
            if (mesaj.getData().startsWith("sahip:")) sahipAyarla(mesaj.getData().endsWith("1"));
            // Yatay Mod düğmesi: telefonun tutuluşuna göre sola ya da sağa yatay (sensör)
            else if (mesaj.getData().startsWith("yatay:")) setRequestedOrientation(mesaj.getData().endsWith("1")
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        });
    }

    private void sahipAyarla(boolean evet) {
        if (evet == sahip) return;
        sahip = evet;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
        if (evet) {
            Set<String> kurallar = new HashSet<>();
            for (String y : YOUTUBE) kurallar.add(y);
            try { reklamsizBetik = WebViewCompat.addDocumentStartJavaScript(web, reklamsizKod, kurallar); } catch (Exception e) { /* desteklenmiyor */ }
        } else if (reklamsizBetik != null) {
            reklamsizBetik.remove();
            reklamsizBetik = null;
        }
    }

    private void istemciler() {
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (ALAN.equals(u.getHost())) return yukleyici.shouldInterceptRequest(u);
                if (dokunulmazMi(u.getHost())) return null;
                String url = u.toString();
                if (url.contains("/youtubei/v1/")) return null;   // oynatıcı verisi (reklam alanları betikte silinir)
                int tur = FiltreMotoru.turTahmin(url, r.getRequestHeaders(), r.isForMainFrame());
                if (motor.engelliMi(url, ALAN, tur)) {
                    return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                // ana sayfa siteden ayrılamaz (reklam yönlendirmeleri); iframe içi gezinmeye karışılmaz
                if (!r.isForMainFrame()) return false;
                return !ALAN.equals(r.getUrl().getHost());
            }

            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap f) {
                // belge başı betik desteklenmiyorsa (çok eski WebView) en azından ana belgeye
                if (sahip && !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && url.contains("youtube"))
                    v.evaluateJavascript(reklamsizKod, null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView v, boolean dialog, boolean kullanici, Message m) {
                return false;   // açılır pencere / yeni sekme yok
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                // zaten tam ekrandayken ikinci istek (Yatay Mod içinde videonun kendi tam ekran düğmesi) -> tamamen çık
                if (tamEkran != null) { cb.onCustomViewHidden(); onHideCustomView(); return; }
                tamEkran = view; tamEkranGeri = cb;
                kok.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                sistemCubuklari(false);
                kok.requestApplyInsets();
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);   // tam ekran video: yatay (sola/sağa sensörle)
            }

            @Override
            public void onHideCustomView() {
                if (tamEkran == null) return;
                kok.removeView(tamEkran);
                tamEkran = null;
                if (tamEkranGeri != null) tamEkranGeri.onCustomViewHidden();
                web.setVisibility(View.VISIBLE);
                sistemCubuklari(true);
                kok.requestApplyInsets();
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            }
        });
    }

    /* Android 15 uygulamayı durum/gezinme çubuklarının altına kadar çizer (edge-to-edge) ve klavye açılınca sayfayı
       küçültmez: kenar boşlukları elle verilir. Klavye açıkken alt boşluk = klavye yüksekliği -> sayfa klavyenin
       üstüne sığar (robot ekranında başlık kaybolmaz). Tam ekran videoda boşluk yok. */
    private void kenarBosluklari() {
        kok.setOnApplyWindowInsetsListener((v, ic) -> {
            if (tamEkran != null) { v.setPadding(0, 0, 0, 0); return ic; }
            if (Build.VERSION.SDK_INT >= 30) {
                Insets c = ic.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets k = ic.getInsets(WindowInsets.Type.ime());
                v.setPadding(c.left, c.top, c.right, Math.max(c.bottom, k.bottom));
                return WindowInsets.CONSUMED;
            }
            return ic;   // Android 10 ve öncesi: pencere çubukların arasında, klavyede adjustResize küçültür

        });
    }

    private void sistemCubuklari(boolean goster) {
        getWindow().getDecorView().setSystemUiVisibility(goster ? View.SYSTEM_UI_FLAG_VISIBLE
            : View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private static boolean dokunulmazMi(String alan) {
        if (alan == null) return false;
        alan = alan.toLowerCase(Locale.ROOT);
        for (String a : DOKUNMA) if (alan.equals(a) || alan.endsWith("." + a)) return true;
        return false;
    }

    private void listeleriYukle() {
        try {
            String[] dosyalar;
            try { dosyalar = getAssets().list("listeler"); } catch (Exception e) { dosyalar = null; }
            if (dosyalar != null) for (String ad : dosyalar) {
                if (!ad.endsWith(".txt")) continue;
                try (InputStream g = getAssets().open("listeler/" + ad)) { motor.yukle(g); } catch (Exception e) { /* bozuk liste atlanır */ }
            }
            // YouTube'a özel ek kurallar (Desktop/adblock reklam-temizle/engel.txt)
            for (String k : new String[]{ "||doubleclick.net^", "||googleadservices.com^", "||googlesyndication.com^",
                    "||adservice.google.com^", "||ads.youtube.com^", "||2mdn.net^", "||moatads.com^",
                    "/pagead/", "/api/stats/ads", "/ptracking" }) motor.satirEkle(k);
        } finally {
            motor.bitti();
        }
    }

    private String assetOku(String ad) {
        try (InputStream g = getAssets().open(ad)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] tampon = new byte[8192]; int n;
            while ((n = g.read(tampon)) != -1) b.write(tampon, 0, n);
            return b.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) { return ""; }
    }

    @Override
    public boolean onKeyDown(int kod, KeyEvent e) {
        if (kod == KeyEvent.KEYCODE_BACK) {
            if (guncelleme != null && guncelleme.acikMi()) return true;   // zorunlu güncelleme: geri tuşu kapatmaz
            if (tamEkran != null) { web.getWebChromeClient().onHideCustomView(); return true; }
            // açık pencere (film detayı, ayarlar, link ekle, robot) varsa onu kapat; yoksa uygulamayı arka plana al
            web.evaluateJavascript(
                "(function(){try{var d=document.getElementById('detail');if(d&&d.classList.contains('open')){closeDetail();return '1'}"
              + "var s=document.getElementById('settings');if(s&&s.classList.contains('show')){closeSettings();return '1'}"
              + "var o=document.getElementById('ozelPanel');if(o&&o.classList.contains('acik')){OZEL.kapat();return '1'}"
              + "var r=document.getElementById('robotPanel');if(r&&r.classList.contains('acik')){r.classList.remove('acik');return '1'}"
              + "}catch(e){}return '0'})()",
                v -> { if (!"\"1\"".equals(v)) moveTaskToBack(true); });
            return true;
        }
        return super.onKeyDown(kod, e);
    }

    @Override protected void onPause() { super.onPause(); if (web != null) web.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); if (guncelleme != null) guncelleme.kontrol(); }
    @Override protected void onDestroy() { if (web != null) web.destroy(); super.onDestroy(); }
}
