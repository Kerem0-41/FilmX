package com.filmx.player;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Uygulama içi zorunlu güncelleme.
 *
 * Netlify'daki surum.json'a bakılır: {"kod": 3, "ad": "2.1", "apk": "FilmX.apk", "not": "..."}
 * (adres: assets/guncelleme.txt, derle.py yazar). kod bu uygulamanınkinden büyükse iptalsiz tam ekran
 * "Güncelleme var" çıkar; "Güncelle" -> APK uygulama içinde iner -> Android yükleyicisi açılır.
 * Play Store dışı uygulamalar kendini sessiz kuramaz: son adımda sistem penceresinde bir dokunuş şart.
 */
class Guncelleme {

    private final Activity a;
    private final FrameLayout kok;
    private final String adres;               // surum.json'un bulunduğu klasör (sonunda / yok)
    private View ekran;
    private TextView durumYazi;
    private ProgressBar cubuk;
    private Button dugme;
    private File apk;                           // inen dosya
    private String apkAdres;
    private boolean indiriliyor = false, izinBekleniyor = false;
    private long sonBakis = 0;

    Guncelleme(Activity a, FrameLayout kok, String adres) {
        this.a = a; this.kok = kok;
        this.adres = adres == null ? "" : adres.trim().replaceAll("/+$", "");
    }

    boolean acikMi() { return ekran != null; }

    /** Açılışta ve uygulamaya her dönüşte (en fazla 10 dakikada bir) sürüm bakılır. */
    void kontrol() {
        if (izinBekleniyor && izinVarMi()) { izinBekleniyor = false; if (apk != null && apk.exists()) kur(); return; }
        if (adres.isEmpty() || indiriliyor || ekran != null) return;
        long simdi = System.currentTimeMillis();
        if (simdi - sonBakis < 10 * 60 * 1000) return;
        sonBakis = simdi;
        new Thread(() -> {
            try {
                JSONObject j = new JSONObject(metinIndir(adres + "/surum.json?t=" + simdi));
                int kod = j.getInt("kod");
                if (kod <= benimKod()) return;
                apkAdres = j.optString("apk", "FilmX.apk");
                if (!apkAdres.startsWith("http")) apkAdres = adres + "/" + apkAdres;
                String ad = j.optString("ad", ""), not = j.optString("not", "");
                a.runOnUiThread(() -> goster(ad, not));
            } catch (Exception e) { sonBakis = 0; /* internet yoksa sonra tekrar */ }
        }, "surum-bak").start();
    }

    private int benimKod() {
        try {
            PackageInfo p = a.getPackageManager().getPackageInfo(a.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? (int) p.getLongVersionCode() : p.versionCode;
        } catch (Exception e) { return Integer.MAX_VALUE; }
    }

    /* ---------------- ekran: iptal yok, geri tuşu kapatmaz ---------------- */
    private void goster(String ad, String not) {
        if (ekran != null) return;
        LinearLayout kutu = new LinearLayout(a);
        kutu.setOrientation(LinearLayout.VERTICAL);
        kutu.setGravity(Gravity.CENTER_HORIZONTAL);
        kutu.setPadding(dp(28), dp(32), dp(28), dp(28));
        GradientDrawable kz = new GradientDrawable();
        kz.setColor(0xFF12151F); kz.setCornerRadius(dp(20)); kz.setStroke(dp(1), 0xFF232838);
        kutu.setBackground(kz);

        TextView x = new TextView(a);
        x.setText("FILMX"); x.setTextColor(0xFFE50914); x.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        x.setTypeface(Typeface.DEFAULT_BOLD); x.setLetterSpacing(-0.02f);
        kutu.addView(x);

        TextView baslik = new TextView(a);
        baslik.setText("Güncelleme var"); baslik.setTextColor(Color.WHITE); baslik.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        baslik.setTypeface(Typeface.DEFAULT_BOLD); baslik.setGravity(Gravity.CENTER); baslik.setPadding(0, dp(18), 0, dp(8));
        kutu.addView(baslik);

        durumYazi = new TextView(a);
        durumYazi.setText("FilmX'in yeni sürümü" + (ad.isEmpty() ? "" : " (" + ad + ")") + " hazır. Devam etmek için güncelle."
            + (not.isEmpty() ? "\n\n" + not : ""));
        durumYazi.setTextColor(0xFFB9C0D4); durumYazi.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        durumYazi.setGravity(Gravity.CENTER); durumYazi.setLineSpacing(0, 1.25f);
        kutu.addView(durumYazi);

        cubuk = new ProgressBar(a, null, android.R.attr.progressBarStyleHorizontal);
        cubuk.setMax(100); cubuk.setVisibility(View.GONE);
        cubuk.setProgressTintList(android.content.res.ColorStateList.valueOf(0xFFE50914));
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(8));
        cp.topMargin = dp(20);
        kutu.addView(cubuk, cp);

        dugme = new Button(a);
        dugme.setText("Güncelle"); dugme.setAllCaps(false); dugme.setTextColor(Color.WHITE);
        dugme.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17); dugme.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable dz = new GradientDrawable();
        dz.setColor(0xFFE50914); dz.setCornerRadius(dp(30));
        dugme.setBackground(dz); dugme.setStateListAnimator(null);
        dugme.setOnClickListener(v -> baslat());
        LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54));
        dl.topMargin = dp(24);
        kutu.addView(dugme, dl);

        FrameLayout arka = new FrameLayout(a);
        arka.setBackgroundColor(0xF2050608);
        arka.setClickable(true);   // alttaki siteye dokunulmasın
        FrameLayout.LayoutParams kp = new FrameLayout.LayoutParams(Math.min(dp(420), a.getResources().getDisplayMetrics().widthPixels - dp(32)),
            ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        arka.addView(kutu, kp);
        ekran = arka;
        kok.addView(arka, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /* ---------------- indir + kur ---------------- */
    private void baslat() {
        if (apk != null && apk.exists()) { kur(); return; }   // daha önce indi, yükleyici kapatıldıysa tekrar aç
        if (indiriliyor) return;
        indiriliyor = true;
        dugme.setEnabled(false); dugme.setAlpha(0.6f); dugme.setText("İndiriliyor…");
        cubuk.setVisibility(View.VISIBLE); cubuk.setProgress(0);
        new Thread(() -> {
            File klasor = new File(a.getCacheDir(), "guncelleme");
            File hedef = new File(klasor, "FilmX.apk"), gecici = new File(klasor, "FilmX.apk.part");
            try {
                klasor.mkdirs(); hedef.delete();
                HttpURLConnection c = (HttpURLConnection) new URL(apkAdres).openConnection();
                c.setInstanceFollowRedirects(true); c.setConnectTimeout(15000); c.setReadTimeout(30000);
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                long toplam = c.getContentLengthLong(), inen = 0;
                try (InputStream g = c.getInputStream(); FileOutputStream o = new FileOutputStream(gecici)) {
                    byte[] t = new byte[65536]; int n, son = -1;
                    while ((n = g.read(t)) != -1) {
                        o.write(t, 0, n); inen += n;
                        int y = toplam > 0 ? (int) (inen * 100 / toplam) : -1;
                        if (y != son) { son = y; final int yy = y; a.runOnUiThread(() -> ilerleme(yy)); }
                    }
                }
                if (!gecici.renameTo(hedef)) throw new Exception("dosya");
                apk = hedef;
                a.runOnUiThread(() -> { indiriliyor = false; dugme.setText("Güncelle"); dugme.setEnabled(true); dugme.setAlpha(1f);
                    durumYazi.setText("İndirme tamamlandı. Açılan pencerede \"Güncelle\"ye dokun."); kur(); });
            } catch (Exception e) {
                gecici.delete();
                a.runOnUiThread(() -> { indiriliyor = false; cubuk.setVisibility(View.GONE);
                    dugme.setText("Tekrar dene"); dugme.setEnabled(true); dugme.setAlpha(1f);
                    durumYazi.setText("Güncelleme indirilemedi. İnternet bağlantını kontrol edip tekrar dene."); });
            }
        }, "guncelleme-indir").start();
    }

    private void ilerleme(int y) {
        if (y < 0) { cubuk.setIndeterminate(true); return; }
        cubuk.setIndeterminate(false); cubuk.setProgress(y);
        durumYazi.setText("İndiriliyor… %" + y);
    }

    private boolean izinVarMi() {
        return Build.VERSION.SDK_INT < 26 || a.getPackageManager().canRequestPackageInstalls();
    }

    private void kur() {
        if (!izinVarMi()) {
            // ilk güncellemede bir kez: "bu uygulamanın uygulama yüklemesine izin ver"
            izinBekleniyor = true;
            durumYazi.setText("Açılan ayarda \"Bu kaynaktan izin ver\"i aç ve geri dön; güncelleme kendiliğinden devam eder.");
            try {
                a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
            } catch (Exception e) { /* ayar açılamazsa düğme tekrar denemeyi sağlar */ }
            return;
        }
        try {
            Uri u = FileProvider.getUriForFile(a, a.getPackageName() + ".dosyalar", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(u, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            a.startActivity(i);
        } catch (Exception e) {
            durumYazi.setText("Yükleyici açılamadı. \"Güncelle\"ye tekrar dokun.");
        }
    }

    private static String metinIndir(String u) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setConnectTimeout(10000); c.setReadTimeout(10000); c.setUseCaches(false);
        c.setRequestProperty("Cache-Control", "no-cache");
        try (InputStream g = c.getInputStream()) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] t = new byte[4096]; int n;
            while ((n = g.read(t)) != -1) b.write(t, 0, n);
            return b.toString("UTF-8");
        }
    }

    private int dp(int d) { return Math.round(d * a.getResources().getDisplayMetrics().density); }
}
