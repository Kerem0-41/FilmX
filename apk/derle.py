# -*- coding: utf-8 -*-
"""
FilmX APK derleme ve yayın.

    python derle.py                    -> deneme APK'sı (Masaüstü/FilmX.apk), sürüm artmaz
    python derle.py yayinla "not"      -> sürümü 1 artırır, kalıcı anahtarla imzalar ve
                                          Masaüstü/FilmX_Netlify/ klasörünü hazırlar:
                                            FilmX.apk     uygulama
                                            surum.json    uygulamaların baktığı sürüm bilgisi
                                            index.html    indirme sayfası
                                          Bu klasörün İÇİNDEKİLERİ Netlify sitesine yüklenir (eskilerin yerine).
                                          Kullanıcıların uygulamasında "Güncelleme var" ekranı çıkar.

Netlify adresi: guncelleme_adresi.txt (ör. https://filmx-indir.netlify.app) — APK'nın içine gömülür.
Önce sitenin güncel hali (../index.html + resimler + filmx.mp3) assets/site/ içine kopyalanır.
"""
import io
import json
import os
import shutil
import subprocess
import sys

KOK = os.path.dirname(os.path.abspath(__file__))           # FilmX/apk
DEPO = os.path.dirname(KOK)                                # FilmX
ASSETS = os.path.join(KOK, "app", "src", "main", "assets")
SITE = os.path.join(ASSETS, "site")
DOSYALAR = ["index.html", "filmx.mp3", "x.mp3", "ai_logo.png", "ai_logo_seffaf.png"] + ["profil%d.png" % i for i in range(1, 6)]
MASAUSTU = os.path.join(os.path.expanduser("~"), "Desktop")
SURUM = os.path.join(KOK, "surum.properties")
ADRES = os.path.join(KOK, "guncelleme_adresi.txt")


def surum_oku():
    d = {}
    with io.open(SURUM, encoding="utf-8") as f:
        for s in f:
            if "=" in s:
                k, v = s.strip().split("=", 1)
                d[k] = v
    return int(d["kod"]), d["ad"]


def surum_yaz(kod, ad):
    with io.open(SURUM, "w", encoding="utf-8") as f:
        f.write("kod=%d\nad=%s\n" % (kod, ad))


def hazirla():
    # site dosyaları
    if os.path.isdir(SITE):
        shutil.rmtree(SITE)
    os.makedirs(SITE)
    for ad in DOSYALAR:
        kaynak = os.path.join(DEPO, ad)
        if os.path.exists(kaynak):
            shutil.copyfile(kaynak, os.path.join(SITE, ad))
        else:
            print("yok (atlandı):", ad)
    # güncelleme adresi
    adres = io.open(ADRES, encoding="utf-8").read().strip() if os.path.exists(ADRES) else ""
    with io.open(os.path.join(ASSETS, "guncelleme.txt"), "w", encoding="utf-8") as f:
        f.write(adres)
    if not adres:
        print("UYARI: guncelleme_adresi.txt yok -> bu APK güncelleme kontrolü YAPMAZ")
    else:
        print("güncelleme adresi:", adres)
    return adres


def derle(tur):
    gorev = "assembleRelease" if tur == "release" else "assembleDebug"
    gradlew = os.path.join(KOK, "gradlew.bat" if os.name == "nt" else "gradlew")
    print("derleniyor:", gorev)
    if subprocess.run([gradlew, gorev, "--console=plain", "-q"], cwd=KOK).returncode != 0:
        print("DERLEME BAŞARISIZ")
        sys.exit(1)
    klasor = os.path.join(KOK, "app", "build", "outputs", "apk", tur)
    apk = next((os.path.join(klasor, a) for a in os.listdir(klasor) if a.endswith(".apk")), None)
    if not apk:
        print("APK bulunamadı:", klasor)
        sys.exit(1)
    return apk


INDIRME_SAYFASI = """<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FilmX İndir</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 20%,#1a0a0c,#050608 60%);
  color:#f5f6fa;font-family:'Segoe UI',system-ui,Arial,sans-serif;padding:16px}
.kart{width:100%;max-width:420px;text-align:center;background:#12151f;border:1px solid #232838;border-radius:22px;padding:36px 28px}
.logo{font-size:44px;font-weight:900;letter-spacing:-1px;color:#e50914}.logo span{color:#fff}
p{color:#b9c0d4;line-height:1.6;margin:14px 0 26px}
a.btn{display:block;padding:16px;border-radius:30px;background:#e50914;color:#fff;font-weight:800;font-size:17px;text-decoration:none;box-shadow:0 10px 30px rgba(229,9,20,.35)}
a.btn:active{transform:scale(.98)}
small{display:block;color:#8b93a7;margin-top:18px;line-height:1.6;font-size:13px}
</style></head>
<body><div class="kart">
<div class="logo">FILM<span>X</span></div>
<p>Android uygulaması · sürüm %(ad)s</p>
<a class="btn" href="FilmX.apk" download>Uygulamayı indir</a>
<small>İndirdikten sonra dosyayı aç. Telefon "bilinmeyen uygulama" uyarısı verirse bu kaynağa izin ver.<br>
Yeni sürümler uygulamanın içinden güncellenir.</small>
</div></body></html>
"""


def yayinla(not_):
    adres = io.open(ADRES, encoding="utf-8").read().strip() if os.path.exists(ADRES) else ""
    if not adres:
        print("HATA: önce guncelleme_adresi.txt dosyasına Netlify adresini yaz (ör. https://filmx-indir.netlify.app)")
        sys.exit(1)
    if not os.path.exists(os.path.join(KOK, "imza", "imza.properties")):
        print("HATA: imza/ klasörü yok. Kalıcı anahtar olmadan yayın yapılamaz (güncellemeler kurulamaz).")
        sys.exit(1)
    kod, _ = surum_oku()
    kod += 1
    ad = "2.%d" % (kod - 2)
    surum_yaz(kod, ad)
    hazirla()
    try:
        apk = derle("release")
    except SystemExit:
        surum_yaz(kod - 1, "2.%d" % (kod - 3))   # başarısızsa sürüm geri alınır
        raise
    cikti = os.path.join(MASAUSTU, "FilmX_Netlify")
    if os.path.isdir(cikti):
        shutil.rmtree(cikti)
    os.makedirs(cikti)
    shutil.copyfile(apk, os.path.join(cikti, "FilmX.apk"))
    with io.open(os.path.join(cikti, "surum.json"), "w", encoding="utf-8") as f:
        json.dump({"kod": kod, "ad": ad, "apk": "FilmX.apk", "not": not_}, f, ensure_ascii=False)
    with io.open(os.path.join(cikti, "index.html"), "w", encoding="utf-8") as f:
        f.write(INDIRME_SAYFASI.replace("%(ad)s", ad))
    # Netlify: surum.json ve APK önbelleğe alınmasın (güncelleme hemen görünsün)
    with io.open(os.path.join(cikti, "_headers"), "w", encoding="utf-8") as f:
        f.write("/surum.json\n  Cache-Control: no-cache\n  Access-Control-Allow-Origin: *\n/FilmX.apk\n  Cache-Control: no-cache\n  Content-Type: application/vnd.android.package-archive\n")
    print("\nYAYIN HAZIR -> %s  (sürüm %s, kod %d)" % (cikti, ad, kod))
    print("Bu klasörün içindekileri Netlify'a yükle. Boyut: %.1f MB" % (os.path.getsize(os.path.join(cikti, "FilmX.apk")) / 1048576.0))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1].lower().startswith("y"):
        yayinla(sys.argv[2] if len(sys.argv) > 2 else "")
    else:
        hazirla()
        apk = derle("release")
        hedef = os.path.join(MASAUSTU, "FilmX.apk")
        shutil.copyfile(apk, hedef)
        print("\nDENEME APK ->", hedef, "(sürüm artmadı, Netlify'a yüklenmez)")
