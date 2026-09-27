package com.filmx.player;

import android.net.Uri;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * EasyList / Adblock Plus sozdizimini okuyup uygulayan motor.
 *
 * Yontem, ABP'nin kendi matcher.js dosyasindaki ile ayni: her kural bir
 * "anahtar kelime" altina kovalanir, gelen adresten cikarilan kelimelerle
 * sadece o kovadaki birkac kural denenir. Boylece 50 binlik listede bile
 * istek basina birkac karsilastirma yapilir.
 *
 * Desteklenen:
 *   ||alan^ , |bas , son| , * , ^  kaliplar
 *   @@ istisna kurallari
 *   $script,image,stylesheet,media,font,xmlhttprequest,subdocument,document,other
 *   $third-party / $~third-party
 *   $domain=a.com|~b.com
 *   ##secici , alan##secici , #@#secici  (kozmetik gizleme)
 *
 * Desteklenmeyen kural satirlari (snippet, csp, rewrite, sitekey, $?# gibi)
 * sessizce atlanir; yanlis engelleme yapmaktansa atlamak daha guvenli.
 */
public class FiltreMotoru {

    /* ================= kural ================= */
    private static final class Kural {
        String ham;                 // kalip metni (regex'e gec cevrilir)
        Pattern kalip;              // ilk kullanimda derlenir
        boolean basAlan;            // ||  ile basliyor
        String duzAlan;             // sade "||alan^" ise regex'e hic gerek yok
        int turler;                 // izin verilen tur maskesi (0 = hepsi)
        int turlerHaric;
        Integer ucuncuTaraf;        // null = fark etmez, 1 = sart, 0 = olmamali
        Set<String> alanlar;        // $domain=
        Set<String> alanlarHaric;
        boolean buyukKucukOnemli;
    }

    /* ================= tur maskeleri ================= */
    public static final int T_BILINMEZ    = 0;
    public static final int T_BELGE       = 1;
    public static final int T_ALTCERCEVE  = 1 << 1;
    public static final int T_BETIK       = 1 << 2;
    public static final int T_STIL        = 1 << 3;
    public static final int T_RESIM       = 1 << 4;
    public static final int T_YAZITIPI    = 1 << 5;
    public static final int T_ORTAM       = 1 << 6;
    public static final int T_XHR         = 1 << 7;
    public static final int T_DIGER       = 1 << 8;

    private static final Map<String, Integer> TUR_ADLARI = new HashMap<>();
    static {
        TUR_ADLARI.put("document", T_BELGE);
        TUR_ADLARI.put("subdocument", T_ALTCERCEVE);
        TUR_ADLARI.put("script", T_BETIK);
        TUR_ADLARI.put("stylesheet", T_STIL);
        TUR_ADLARI.put("image", T_RESIM);
        TUR_ADLARI.put("font", T_YAZITIPI);
        TUR_ADLARI.put("media", T_ORTAM);
        TUR_ADLARI.put("xmlhttprequest", T_XHR);
        TUR_ADLARI.put("other", T_DIGER);
        TUR_ADLARI.put("object", T_DIGER);
        TUR_ADLARI.put("ping", T_DIGER);
        TUR_ADLARI.put("websocket", T_DIGER);
        TUR_ADLARI.put("object-subrequest", T_DIGER);
    }

    /** Anlamadigimiz secenekler: kurali tamamen atla. */
    private static final String[] ANLASILMAYAN = {
            "csp", "rewrite", "sitekey", "genericblock", "generichide",
            "elemhide", "popup", "webrtc", "inline-script", "inline-font", "header"
    };

    /* ================= depolar ================= */
    private final Map<String, List<Kural>> engelKova = new HashMap<>();
    private final Map<String, List<Kural>> istisnaKova = new HashMap<>();
    private final List<Kural> engelGenel = new ArrayList<>();
    private final List<Kural> istisnaGenel = new ArrayList<>();

    /** sade "||alan^" kurallari: regex yok, dogrudan alan aramasi */
    private final Set<String> engelAlanlar = new HashSet<>();

    /** kozmetik gizleme */
    private final List<String> kozmetikGenel = new ArrayList<>();
    private final Map<String, List<String>> kozmetikAlan = new HashMap<>();
    private final Set<String> kozmetikIstisna = new HashSet<>();

    private volatile boolean hazir = false;
    private int kuralSayisi = 0;

    public boolean hazirMi() { return hazir; }
    public int kacKural() { return kuralSayisi; }

    /* =====================================================
       YUKLEME
       ===================================================== */
    public void yukle(InputStream akis) {
        try (BufferedReader oku = new BufferedReader(
                new InputStreamReader(akis, StandardCharsets.UTF_8), 1 << 16)) {
            String satir;
            while ((satir = oku.readLine()) != null) satirEkle(satir);
        } catch (Exception yok) { /* bozuk liste yuklemeyi durdurmasin */ }
    }

    public void bitti() { hazir = true; }

    public void satirEkle(String satir) {
        satir = satir.trim();
        if (satir.isEmpty()) return;
        char ilk = satir.charAt(0);
        if (ilk == '!' || ilk == '[' || ilk == '#' && satir.startsWith("#!")) return;

        // --- kozmetik kurallar ---
        int k = satir.indexOf("##");
        int ki = satir.indexOf("#@#");
        if (ki >= 0) { kozmetikEkle(satir.substring(0, ki), satir.substring(ki + 3), true); return; }
        if (satir.contains("#?#") || satir.contains("#$#") || satir.contains("#%#")) return; // gelismis: atla
        if (k >= 0) { kozmetikEkle(satir.substring(0, k), satir.substring(k + 2), false); return; }

        // --- ag kurallari ---
        boolean istisna = satir.startsWith("@@");
        if (istisna) satir = satir.substring(2);

        String secenek = null;
        int d = satir.lastIndexOf('$');
        if (d > 0) { secenek = satir.substring(d + 1); satir = satir.substring(0, d); }
        if (satir.isEmpty()) return;
        if (satir.startsWith("/") && satir.endsWith("/") && satir.length() > 2) return; // ham regex: atla

        Kural kural = new Kural();
        if (secenek != null && !seceneginiIsle(kural, secenek)) return;   // anlasilmayan secenek

        if (satir.startsWith("||")) { kural.basAlan = true; satir = satir.substring(2); }
        kural.ham = satir;

        // sade alan kurali mi? ("||reklam.com^" gibi)
        if (kural.basAlan && !istisna && kural.turler == 0 && kural.turlerHaric == 0
                && kural.ucuncuTaraf == null && kural.alanlar == null
                && satir.endsWith("^") && sadeAlanMi(satir.substring(0, satir.length() - 1))) {
            engelAlanlar.add(satir.substring(0, satir.length() - 1).toLowerCase(Locale.ROOT));
            kuralSayisi++;
            return;
        }

        String anahtar = anahtarBul(satir);
        Map<String, List<Kural>> kova = istisna ? istisnaKova : engelKova;
        List<Kural> genel = istisna ? istisnaGenel : engelGenel;

        if (anahtar == null) {
            if (genel.size() < 4000) genel.add(kural);   // kelimesiz kurallar sinirli tutulur
        } else {
            List<Kural> l = kova.get(anahtar);
            if (l == null) { l = new ArrayList<>(2); kova.put(anahtar, l); }
            l.add(kural);
        }
        kuralSayisi++;
    }

    private static boolean sadeAlanMi(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (!(Character.isLetterOrDigit(c) || c == '.' || c == '-')) return false;
        }
        return s.indexOf('.') > 0;
    }

    private boolean seceneginiIsle(Kural kural, String secenek) {
        for (String p : secenek.split(",")) {
            p = p.trim().toLowerCase(Locale.ROOT);
            if (p.isEmpty()) continue;
            boolean ters = p.startsWith("~");
            if (ters) p = p.substring(1);

            if (p.startsWith("domain=")) {
                for (String a : p.substring(7).split("\\|")) {
                    if (a.isEmpty()) continue;
                    if (a.startsWith("~")) {
                        if (kural.alanlarHaric == null) kural.alanlarHaric = new HashSet<>();
                        kural.alanlarHaric.add(a.substring(1));
                    } else {
                        if (kural.alanlar == null) kural.alanlar = new HashSet<>();
                        kural.alanlar.add(a);
                    }
                }
                continue;
            }
            if (p.equals("third-party")) { kural.ucuncuTaraf = ters ? 0 : 1; continue; }
            if (p.equals("match-case")) { kural.buyukKucukOnemli = true; continue; }
            if (p.equals("all")) continue;

            Integer tur = TUR_ADLARI.get(p);
            if (tur != null) {
                if (ters) kural.turlerHaric |= tur; else kural.turler |= tur;
                continue;
            }
            for (String kotu : ANLASILMAYAN) if (p.startsWith(kotu)) return false;
            // tanimadigimiz ama zararsiz secenekler yok sayilir
        }
        return true;
    }

    private void kozmetikEkle(String alanlar, String secici, boolean istisna) {
        secici = secici.trim();
        if (secici.isEmpty() || secici.length() > 400) return;
        if (secici.contains(":-abp-") || secici.contains(":has-text")) return;   // gelismis: atla

        if (istisna) { kozmetikIstisna.add(secici); return; }

        if (alanlar.isEmpty()) {
            kozmetikGenel.add(secici);
        } else {
            for (String a : alanlars(alanlar)) {
                List<String> l = kozmetikAlan.get(a);
                if (l == null) { l = new ArrayList<>(2); kozmetikAlan.put(a, l); }
                l.add(secici);
            }
        }
    }

    private static List<String> alanlars(String metin) {
        List<String> c = new ArrayList<>();
        for (String a : metin.split(",")) {
            a = a.trim().toLowerCase(Locale.ROOT);
            if (!a.isEmpty() && !a.startsWith("~")) c.add(a);
        }
        return c;
    }

    /* =====================================================
       ANAHTAR KELIME  (ABP matcher.js ile ayni fikir)
       ===================================================== */
    private static final Pattern KELIME = Pattern.compile("[a-z0-9%]{4,}");

    private static String anahtarBul(String kalip) {
        Matcher m = KELIME.matcher(kalip.toLowerCase(Locale.ROOT));
        String enIyi = null;
        while (m.find()) {
            String s = m.group();
            if (s.equals("http") || s.equals("https") || s.equals("www")) continue;
            if (enIyi == null || s.length() > enIyi.length()) enIyi = s;
        }
        return enIyi;
    }

    private static List<String> adresKelimeleri(String adres) {
        List<String> c = new ArrayList<>(8);
        Matcher m = KELIME.matcher(adres);
        while (m.find()) c.add(m.group());
        return c;
    }

    /* =====================================================
       ESLESTIRME
       ===================================================== */

    /**
     * @param adres     istenen adres
     * @param sayfaAlan o an acik sayfanin alan adi (ucuncu taraf hesabi icin)
     * @param tur       kaynak turu (T_* maskesi, bilinmiyorsa T_BILINMEZ)
     */
    public boolean engelliMi(String adres, String sayfaAlan, int tur) {
        if (!hazir) return false;

        String kucuk = adres.toLowerCase(Locale.ROOT);
        String istekAlan = alanCikar(kucuk);
        if (istekAlan == null) return false;

        // 1) sade alan listesi (en hizli yol)
        if (alanVarMi(engelAlanlar, istekAlan)) {
            if (!istisnaVarMi(kucuk, istekAlan, sayfaAlan, tur)) return true;
            return false;
        }

        // 2) kovalar
        List<String> kelimeler = adresKelimeleri(kucuk);
        for (String kelime : kelimeler) {
            List<Kural> l = engelKova.get(kelime);
            if (l != null && birineUyuyorMu(l, kucuk, istekAlan, sayfaAlan, tur)) {
                return !istisnaVarMi(kucuk, istekAlan, sayfaAlan, tur);
            }
        }
        if (birineUyuyorMu(engelGenel, kucuk, istekAlan, sayfaAlan, tur)) {
            return !istisnaVarMi(kucuk, istekAlan, sayfaAlan, tur);
        }
        return false;
    }

    private boolean istisnaVarMi(String adres, String istekAlan, String sayfaAlan, int tur) {
        for (String kelime : adresKelimeleri(adres)) {
            List<Kural> l = istisnaKova.get(kelime);
            if (l != null && birineUyuyorMu(l, adres, istekAlan, sayfaAlan, tur)) return true;
        }
        return birineUyuyorMu(istisnaGenel, adres, istekAlan, sayfaAlan, tur);
    }

    private boolean birineUyuyorMu(List<Kural> liste, String adres, String istekAlan,
                                   String sayfaAlan, int tur) {
        for (int i = 0; i < liste.size(); i++) {
            if (uyuyorMu(liste.get(i), adres, istekAlan, sayfaAlan, tur)) return true;
        }
        return false;
    }

    private boolean uyuyorMu(Kural kural, String adres, String istekAlan, String sayfaAlan, int tur) {
        // Tur suzgeci. WebView istegin turunu her zaman sezdiremiyor; boyle
        // durumda tur kisitli kurali UYGULAMIYORUZ. Aksi halde "$image" icin
        // yazilmis bir kural video akisini da keser ve video hic acilmaz.
        if (kural.turler != 0) {
            if (tur == T_BILINMEZ) return false;
            if ((kural.turler & tur) == 0) return false;
        }
        if (tur != T_BILINMEZ && (kural.turlerHaric & tur) != 0) return false;

        // ucuncu taraf
        if (kural.ucuncuTaraf != null && sayfaAlan != null) {
            boolean ucuncu = !ayniKok(istekAlan, sayfaAlan);
            if ((kural.ucuncuTaraf == 1) != ucuncu) return false;
        }

        // $domain=
        if (sayfaAlan != null) {
            if (kural.alanlarHaric != null && alanVarMi(kural.alanlarHaric, sayfaAlan)) return false;
            if (kural.alanlar != null && !alanVarMi(kural.alanlar, sayfaAlan)) return false;
        }

        if (kural.kalip == null) {
            try { kural.kalip = Pattern.compile(regexeCevir(kural), Pattern.CASE_INSENSITIVE); }
            catch (Exception bozuk) { kural.kalip = Pattern.compile("(?!)"); }
        }
        return kural.kalip.matcher(adres).find();
    }

    /** ABP kalip dilini duzenli ifadeye cevirir. */
    private static String regexeCevir(Kural kural) {
        String s = kural.ham;
        StringBuilder b = new StringBuilder(s.length() + 24);

        if (kural.basAlan) b.append("^[a-z\\-]+://([^/?#]+\\.)?");
        else if (s.startsWith("|")) { b.append('^'); s = s.substring(1); }

        boolean sonaBagli = s.endsWith("|");
        if (sonaBagli) s = s.substring(0, s.length() - 1);

        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '*': b.append(".*"); break;
                case '^': b.append("[^a-z0-9_\\-.%]"); break;
                case '.': case '?': case '+': case '(': case ')': case '[': case ']':
                case '{': case '}': case '$': case '\\': case '|':
                    b.append('\\').append(c); break;
                default: b.append(c);
            }
        }
        if (sonaBagli) b.append('$');
        return b.toString();
    }

    /* =====================================================
       KOZMETIK
       ===================================================== */
    /** Verilen alan icin gizleme CSS'i uretir. */
    public String kozmetikCss(String alan, boolean genelDahil) {
        List<String> secicilier = new ArrayList<>();
        if (genelDahil) secicilier.addAll(kozmetikGenel);

        if (alan != null) {
            String a = alan;
            while (a != null) {
                List<String> l = kozmetikAlan.get(a);
                if (l != null) secicilier.addAll(l);
                int n = a.indexOf('.');
                a = (n >= 0 && a.indexOf('.', n + 1) >= 0) ? a.substring(n + 1) : null;
            }
        }
        if (secicilier.isEmpty()) return "";

        StringBuilder b = new StringBuilder(secicilier.size() * 24);
        int sayac = 0;
        for (String s : secicilier) {
            if (kozmetikIstisna.contains(s)) continue;
            if (sayac > 0) b.append(',');
            b.append(s);
            if (++sayac % 400 == 0) { b.append("{display:none!important}\n"); sayac = 0; }
        }
        if (sayac > 0) b.append("{display:none!important}\n");
        return b.toString();
    }

    /* =====================================================
       ufak yardimcilar
       ===================================================== */
    public static String alanCikar(String adres) {
        try {
            String a = Uri.parse(adres).getHost();
            return a == null ? null : a.toLowerCase(Locale.ROOT);
        } catch (Exception yok) { return null; }
    }

    private static boolean alanVarMi(Set<String> kume, String alan) {
        if (alan == null || kume.isEmpty()) return false;
        String a = alan;
        while (true) {
            if (kume.contains(a)) return true;
            int n = a.indexOf('.');
            if (n < 0) return false;
            a = a.substring(n + 1);
            if (a.indexOf('.') < 0) return kume.contains(a);
        }
    }

    /** iki alan ayni ana alana mi ait ("a.youtube.com" ve "youtube.com") */
    private static boolean ayniKok(String a, String b) {
        if (a == null || b == null) return true;
        return kok(a).equals(kok(b));
    }

    private static String kok(String alan) {
        String[] p = alan.split("\\.");
        if (p.length < 2) return alan;
        return p[p.length - 2] + "." + p[p.length - 1];
    }

    /** WebView'in verdigi ipuclarindan kaynak turunu tahmin eder. */
    public static int turTahmin(String adres, Map<String, String> baslik, boolean anaCerceve) {
        if (anaCerceve) return T_BELGE;

        String kabul = null;
        if (baslik != null) {
            for (Map.Entry<String, String> g : baslik.entrySet()) {
                if ("accept".equalsIgnoreCase(g.getKey())) { kabul = g.getValue(); break; }
            }
        }
        if (kabul != null) {
            String k = kabul.toLowerCase(Locale.ROOT);
            if (k.startsWith("text/css")) return T_STIL;
            if (k.startsWith("image/")) return T_RESIM;
            if (k.contains("text/html")) return T_ALTCERCEVE;
        }

        String yol = adres.toLowerCase(Locale.ROOT);
        int s = yol.indexOf('?');
        if (s > 0) yol = yol.substring(0, s);

        if (yol.endsWith(".js") || yol.endsWith(".mjs")) return T_BETIK;
        if (yol.endsWith(".css")) return T_STIL;
        if (yol.endsWith(".png") || yol.endsWith(".jpg") || yol.endsWith(".jpeg")
                || yol.endsWith(".gif") || yol.endsWith(".webp") || yol.endsWith(".svg")
                || yol.endsWith(".ico")) return T_RESIM;
        if (yol.endsWith(".woff") || yol.endsWith(".woff2") || yol.endsWith(".ttf")
                || yol.endsWith(".otf")) return T_YAZITIPI;
        if (yol.endsWith(".mp4") || yol.endsWith(".webm") || yol.endsWith(".m4a")
                || yol.endsWith(".mp3") || yol.endsWith(".m3u8") || yol.endsWith(".mpd")) return T_ORTAM;
        return T_BILINMEZ;
    }

    public List<String> ozet() {
        List<String> l = new ArrayList<>();
        l.add("sade alan kurali : " + engelAlanlar.size());
        l.add("engel kovasi     : " + engelKova.size());
        l.add("istisna kovasi   : " + istisnaKova.size());
        l.add("kozmetik genel   : " + kozmetikGenel.size());
        l.add("kozmetik alan    : " + kozmetikAlan.size());
        return Collections.unmodifiableList(l);
    }
}
