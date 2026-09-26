// FilmX Giriş — Cloudflare Worker (arka uç)
// Hesaplar, onay, oturumlar, izleme takibi ve yönetim paneli verisi. Veritabanı: D1 filmx-db (g_ ile başlayan tablolar).
// Güvenlik: şifreler PBKDF2-SHA256 (tuzlu) hash olarak, oturum anahtarları SHA-256 hash olarak saklanır; hiçbir cevapta şifre/hash yok.
// Film kataloğu sayfada AES-GCM ile şifreli durur; çözme anahtarı (ICERIK_ANAHTARI, gizli değişken) yalnızca onaylı + açık hesaba verilir.

const ITER = 100000;                       // PBKDF2 tur sayısı (Workers üst sınırı)
const OTURUM_GUN = 30;
const CEVRIMICI_SN = 150;                  // son nabız bu kadar saniye içindeyse "çevrimiçi"
const IZLEME_ARA_SN = 180;                 // aynı filme bu süre içinde gelen nabız aynı izleme kaydını uzatır
const DENEME_SINIRI = 8, DENEME_PENCERE = 15 * 60;   // 15 dakikada 8 hatalı giriş -> geçici kilit
const KAYIT_SINIRI = 5, KAYIT_PENCERE = 60 * 60;     // IP başına saatte 5 kayıt

const now = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();
const b64 = u8 => btoa(String.fromCharCode(...u8));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const rastgele = n => crypto.getRandomValues(new Uint8Array(n));

function cors(req, env) {
  const izinli = (env.IZINLI_ADRESLER || '').split(',').map(s => s.trim()).filter(Boolean);
  const o = req.headers.get('Origin') || 'null';
  return {
    'Access-Control-Allow-Origin': izinli.includes(o) ? o : (izinli[0] || 'null'),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const GUV = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (veri, durum, h) => new Response(JSON.stringify(veri), { status: durum || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...GUV, ...h } });
class Hata extends Error { constructor(kod, mesaj) { super(mesaj); this.kod = kod; } }

async function sifreOzet(sifre, tuzHex) {
  const tuz = new Uint8Array(tuzHex.match(/../g).map(h => parseInt(h, 16)));
  const k = await crypto.subtle.importKey('raw', enc.encode(sifre), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: tuz, iterations: ITER }, k, 256));
}
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
// sabit zamanlı karşılaştırma
function esit(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

let kuruldu = false;
async function kur(db) {
  if (kuruldu) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS g_kullanici (id INTEGER PRIMARY KEY AUTOINCREMENT, ad TEXT NOT NULL UNIQUE COLLATE NOCASE, tuz TEXT NOT NULL, ozet TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'musteri', durum TEXT NOT NULL DEFAULT 'bekliyor', kurucu INTEGER NOT NULL DEFAULT 0, olusturma INTEGER NOT NULL,
      son_gorulme INTEGER, simdi TEXT, simdi_zaman INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS g_oturum (ozet TEXT PRIMARY KEY, kullanici_id INTEGER NOT NULL, cihaz TEXT, olusturma INTEGER NOT NULL, bitis INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS g_giris (id INTEGER PRIMARY KEY AUTOINCREMENT, kullanici_id INTEGER NOT NULL, cihaz TEXT, cihaz_ad TEXT, zaman INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS g_izleme (id INTEGER PRIMARY KEY AUTOINCREMENT, kullanici_id INTEGER NOT NULL, slug TEXT NOT NULL, ad TEXT, baslangic INTEGER NOT NULL, bitis INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS g_cihaz (cihaz TEXT PRIMARY KEY, cihaz_ad TEXT, ilk INTEGER NOT NULL, son INTEGER NOT NULL, ziyaret INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS g_deneme (anahtar TEXT PRIMARY KEY, adet INTEGER NOT NULL, bas INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS g_ozel (id INTEGER PRIMARY KEY, veri TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS g_giris_k ON g_giris(kullanici_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS g_giris_c ON g_giris(cihaz)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS g_izleme_k ON g_izleme(kullanici_id, bitis)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS g_oturum_k ON g_oturum(kullanici_id)`),
  ]);
  kuruldu = true;
}

// hız sınırı: anahtar başına pencere içinde en fazla n deneme
async function sinir(db, anahtar, n, pencere, artir) {
  const t = now();
  const r = await db.prepare('SELECT adet, bas FROM g_deneme WHERE anahtar=?').bind(anahtar).first();
  const gecerli = r && t - r.bas < pencere;
  if (gecerli && r.adet >= n) throw new Hata(429, 'Çok fazla deneme. Biraz sonra tekrar deneyin.');
  if (artir) await db.prepare('INSERT INTO g_deneme (anahtar, adet, bas) VALUES (?, 1, ?) ON CONFLICT(anahtar) DO UPDATE SET adet = CASE WHEN ? - bas < ? THEN adet + 1 ELSE 1 END, bas = CASE WHEN ? - bas < ? THEN bas ELSE ? END')
    .bind(anahtar, t, t, pencere, t, pencere, t).run();
}
const sinirSifirla = (db, anahtar) => db.prepare('DELETE FROM g_deneme WHERE anahtar=?').bind(anahtar).run();

const temizCihaz = c => String(c || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || null;
const temizMetin = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').slice(0, n);
// dok: sayfa dokunmatik ekran bildirdi (iPad Safari kendini Mac olarak tanıtır)
function cihazAdi(ua, dok) {
  ua = ua || '';
  if (dok && /Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua)) ua = ua.replace('Macintosh', 'iPad').replace('Mac OS X', 'iPad OS');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Bilinmeyen';
  const tr = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Tarayıcı';
  return os + ' · ' + tr;
}
const disaAc = k => ({ id: k.id, ad: k.ad, rol: k.rol, durum: k.durum, ...(k.kurucu ? { kurucu: true } : {}) });   // kurucu bilgisi sadece kendi hesabına döner

async function oturumAc(db, k, cihaz, ua, dok) {
  const token = b64(rastgele(32)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
  const t = now();
  await db.batch([
    db.prepare('INSERT INTO g_oturum (ozet, kullanici_id, cihaz, olusturma, bitis) VALUES (?, ?, ?, ?, ?)').bind(await sha256(token), k.id, cihaz, t, t + OTURUM_GUN * 86400),
    db.prepare('INSERT INTO g_giris (kullanici_id, cihaz, cihaz_ad, zaman) VALUES (?, ?, ?, ?)').bind(k.id, cihaz, cihazAdi(ua, dok), t),
    db.prepare('DELETE FROM g_oturum WHERE bitis < ?').bind(t),
  ]);
  return token;
}

async function kimlik(req, db) {
  const h = req.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token || token.length > 100) throw new Hata(401, 'Oturum yok.');
  const k = await db.prepare(`SELECT k.* FROM g_oturum o JOIN g_kullanici k ON k.id = o.kullanici_id WHERE o.ozet = ? AND o.bitis > ?`).bind(await sha256(token), now()).first();
  if (!k) throw new Hata(401, 'Oturumun süresi doldu. Tekrar giriş yapın.');
  k._token = token;
  return k;
}
const girebilir = k => k.durum === 'aktif';
function yonetici(k) { if (!(girebilir(k) && k.rol === 'admin')) throw new Hata(403, 'Yetkiniz yok.'); }

// ---------------- uçlar ----------------
async function kayit(req, env, db, v) {
  const ad = String(v.kullanici || '').trim(), sifre = String(v.sifre || '');
  if (!/^[a-zA-Z0-9._-]{3,24}$/.test(ad)) throw new Hata(400, 'Kullanıcı adı 3-24 karakter olmalı (harf, rakam, . _ -).');
  if (sifre.length < 8 || sifre.length > 128) throw new Hata(400, 'Şifre en az 8 karakter olmalı.');
  const ip = req.headers.get('CF-Connecting-IP') || '?';
  await sinir(db, 'kayit:' + ip, KAYIT_SINIRI, KAYIT_PENCERE, true);
  const tuz = hex(rastgele(16)), ozet = await sifreOzet(sifre, tuz);
  const r = await db.prepare(`INSERT INTO g_kullanici (ad, tuz, ozet, rol, durum, olusturma) VALUES (?, ?, ?, 'musteri', 'bekliyor', ?) ON CONFLICT(ad) DO NOTHING RETURNING *`).bind(ad, tuz, ozet, now()).first();
  if (!r) throw new Hata(409, 'Bu kullanıcı adı alınmış. Başka bir ad seçin.');
  const token = await oturumAc(db, r, temizCihaz(v.cihaz), req.headers.get('User-Agent'), v.dok === true);
  return { token, kullanici: disaAc(r) };
}

async function giris(req, env, db, v) {
  const ad = String(v.kullanici || '').trim().slice(0, 64), sifre = String(v.sifre || '').slice(0, 128);
  const ip = req.headers.get('CF-Connecting-IP') || '?';
  const anahtarlar = ['giris-ip:' + ip, 'giris-ad:' + ad.toLowerCase()];
  for (const a of anahtarlar) await sinir(db, a, DENEME_SINIRI, DENEME_PENCERE, false);
  const k = await db.prepare('SELECT * FROM g_kullanici WHERE ad = ?').bind(ad).first();
  // kullanıcı yoksa da aynı sürede hash hesapla (ad var mı yok mu anlaşılmasın)
  const ozet = await sifreOzet(sifre, k ? k.tuz : '00000000000000000000000000000000');
  if (!k || !esit(ozet, k.ozet)) {
    for (const a of anahtarlar) await sinir(db, a, DENEME_SINIRI, DENEME_PENCERE, true);
    throw new Hata(401, 'Kullanıcı adı ya da şifre yanlış.');
  }
  for (const a of anahtarlar) await sinirSifirla(db, a);
  if (k.durum === 'reddedildi') throw new Hata(403, 'Bu hesabın başvurusu kabul edilmedi.');
  const token = await oturumAc(db, k, temizCihaz(v.cihaz), req.headers.get('User-Agent'), v.dok === true);
  return { token, kullanici: disaAc(k) };
}

async function ben(req, env, db) {
  const k = await kimlik(req, db);
  await db.prepare('UPDATE g_kullanici SET son_gorulme=? WHERE id=?').bind(now(), k.id).run();
  const cevap = { kullanici: disaAc(k) };
  if (girebilir(k)) cevap.anahtar = env.ICERIK_ANAHTARI;   // katalog çözme anahtarı: yalnız onaylı + açık hesaba
  return cevap;
}

async function cikis(req, env, db) {
  const k = await kimlik(req, db);
  await db.batch([
    db.prepare('DELETE FROM g_oturum WHERE ozet=?').bind(await sha256(k._token)),
    db.prepare('UPDATE g_kullanici SET simdi=NULL, simdi_zaman=NULL, son_gorulme=? WHERE id=?').bind(now() - CEVRIMICI_SN, k.id),
  ]);
  return { tamam: true };
}

// sayfa açıkken 30 sn'de bir: çevrimiçi + şu an izlenen
async function nabiz(req, env, db, v) {
  const k = await kimlik(req, db);
  const t = now();
  const iz = v.izliyor && v.izliyor.s ? { s: temizMetin(v.izliyor.s, 120), t: temizMetin(v.izliyor.t, 160) } : null;
  const is = [db.prepare('UPDATE g_kullanici SET son_gorulme=?, simdi=?, simdi_zaman=? WHERE id=?').bind(t, iz ? JSON.stringify(iz) : null, iz ? t : null, k.id)];
  if (iz && girebilir(k)) {
    const son = await db.prepare('SELECT id FROM g_izleme WHERE kullanici_id=? AND slug=? AND bitis > ? ORDER BY bitis DESC LIMIT 1').bind(k.id, iz.s, t - IZLEME_ARA_SN).first();
    is.push(son ? db.prepare('UPDATE g_izleme SET bitis=? WHERE id=?').bind(t, son.id)
                : db.prepare('INSERT INTO g_izleme (kullanici_id, slug, ad, baslangic, bitis) VALUES (?, ?, ?, ?, ?)').bind(k.id, iz.s, iz.t, t, t));
  }
  await db.batch(is);
  return { kullanici: disaAc(k) };
}

// sayfa ziyareti (giriş yapmadan da sayılır): cihaz sayımı için
async function ziyaret(req, env, db, v) {
  const c = temizCihaz(v.cihaz); if (!c) return { tamam: true };
  const t = now();
  await db.prepare('INSERT INTO g_cihaz (cihaz, cihaz_ad, ilk, son, ziyaret) VALUES (?, ?, ?, ?, 1) ON CONFLICT(cihaz) DO UPDATE SET son=excluded.son, cihaz_ad=excluded.cihaz_ad, ziyaret=ziyaret+1')
    .bind(c, cihazAdi(req.headers.get('User-Agent'), v.dok === true), t, t).run();
  return { tamam: true };
}

// yöneticinin eklediği filmler/bölümler (herkes görür, sadece yönetici değiştirir)
async function ozelOku(req, env, db) {
  const k = await kimlik(req, db); if (!girebilir(k)) throw new Hata(403, 'Hesabınız onay bekliyor.');
  const r = await db.prepare('SELECT veri FROM g_ozel WHERE id=1').first();
  return { liste: r ? JSON.parse(r.veri) : [] };
}
async function ozelYaz(req, env, db, v) {
  const k = await kimlik(req, db); yonetici(k);
  if (!k.kurucu) throw new Hata(403, 'Yetkiniz yok.');   // Link Ekle yalnız kurucu hesapta
  if (!Array.isArray(v.liste)) throw new Hata(400, 'Liste gerekli.');
  const veri = JSON.stringify(v.liste);
  if (veri.length > 900000) throw new Hata(413, 'Liste çok büyük.');
  await db.prepare('INSERT INTO g_ozel (id, veri) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET veri=excluded.veri').bind(veri).run();
  return { tamam: true };
}

// ---------------- yönetim ----------------
// kurucu hesap hiçbir listede görünmez ve kimse (başka yöneticiler dahil) onu değiştiremez
async function yOzet(req, env, db) {
  const k = await kimlik(req, db); yonetici(k);
  const t = now();
  const kullanicilar = (await db.prepare(`SELECT k.id, k.ad, k.rol, k.durum, k.olusturma, k.son_gorulme, k.simdi, k.simdi_zaman,
      (SELECT COUNT(*) FROM g_giris g WHERE g.kullanici_id=k.id) AS giris_sayisi,
      (SELECT COUNT(DISTINCT g.cihaz) FROM g_giris g WHERE g.kullanici_id=k.id) AS cihaz_sayisi,
      (SELECT COUNT(*) FROM g_izleme i WHERE i.kullanici_id=k.id) AS izleme_sayisi,
      (SELECT COALESCE(SUM(i.bitis - i.baslangic),0) FROM g_izleme i WHERE i.kullanici_id=k.id) AS izleme_sn
    FROM g_kullanici k WHERE k.kurucu=0 ORDER BY k.olusturma DESC`).all()).results.map(u => {
      const cevrimici = !!(u.son_gorulme && t - u.son_gorulme < CEVRIMICI_SN);
      let simdi = null; if (cevrimici && u.simdi && u.simdi_zaman && t - u.simdi_zaman < CEVRIMICI_SN) try { simdi = JSON.parse(u.simdi); } catch (e) {}
      return { ...u, simdi, simdi_zaman: undefined, cevrimici };
    });
  const kurucuId = (await db.prepare('SELECT id FROM g_kullanici WHERE kurucu=1').all()).results.map(r => r.id);
  const gizli = kurucuId.length ? `AND g.kullanici_id NOT IN (${kurucuId.map(() => '?').join(',')})` : '';
  const cihazlar = (await db.prepare(`SELECT c.cihaz, c.cihaz_ad, c.ilk, c.son, c.ziyaret,
      (SELECT COUNT(*) FROM g_giris g WHERE g.cihaz=c.cihaz ${gizli}) AS giris_sayisi,
      (SELECT COUNT(DISTINCT g.kullanici_id) FROM g_giris g WHERE g.cihaz=c.cihaz ${gizli}) AS kisi_sayisi,
      (SELECT GROUP_CONCAT(ad, ', ') FROM (SELECT DISTINCT k.ad FROM g_giris g JOIN g_kullanici k ON k.id=g.kullanici_id WHERE g.cihaz=c.cihaz ${gizli})) AS kisiler
    FROM g_cihaz c WHERE c.cihaz NOT IN (SELECT DISTINCT g.cihaz FROM g_giris g WHERE g.cihaz IS NOT NULL AND g.kullanici_id IN (SELECT id FROM g_kullanici WHERE kurucu=1))
    ORDER BY c.son DESC LIMIT 300`).bind(...kurucuId, ...kurucuId, ...kurucuId).all()).results;
  return { kullanicilar, cihazlar, simdi: t };
}

async function yKullanici(req, env, db, v) {
  const k = await kimlik(req, db); yonetici(k);
  const id = +v.id;
  const u = await db.prepare('SELECT id, ad, rol, durum, olusturma, son_gorulme FROM g_kullanici WHERE id=? AND kurucu=0').bind(id).first();
  if (!u) throw new Hata(404, 'Kullanıcı bulunamadı.');
  const izlemeler = (await db.prepare('SELECT slug, ad, baslangic, bitis FROM g_izleme WHERE kullanici_id=? ORDER BY bitis DESC LIMIT 200').bind(id).all()).results;
  const girisler = (await db.prepare('SELECT cihaz, cihaz_ad, zaman FROM g_giris WHERE kullanici_id=? ORDER BY zaman DESC LIMIT 100').bind(id).all()).results;
  return { kullanici: u, izlemeler, girisler };
}

async function yIslem(req, env, db, v) {
  const k = await kimlik(req, db); yonetici(k);
  const id = +v.id, islem = String(v.islem || '');
  const u = await db.prepare('SELECT id, kurucu FROM g_kullanici WHERE id=?').bind(id).first();
  if (!u || u.kurucu) throw new Hata(404, 'Kullanıcı bulunamadı.');
  if (u.id === k.id && islem !== 'rol') throw new Hata(400, 'Kendi hesabınızda bu işlem yapılamaz.');
  const oturumSil = db.prepare('DELETE FROM g_oturum WHERE kullanici_id=?').bind(id);
  switch (islem) {
    case 'onayla': case 'ac':
      await db.prepare("UPDATE g_kullanici SET durum='aktif' WHERE id=?").bind(id).run(); break;
    case 'reddet':
      await db.batch([db.prepare("UPDATE g_kullanici SET durum='reddedildi' WHERE id=?").bind(id), oturumSil]); break;
    case 'kapat':
      await db.batch([db.prepare("UPDATE g_kullanici SET durum='kapali', simdi=NULL WHERE id=?").bind(id), oturumSil]); break;
    case 'rol': {
      const rol = v.rol === 'admin' ? 'admin' : 'musteri';
      if (u.id === k.id) throw new Hata(400, 'Kendi yetkinizi değiştiremezsiniz.');
      await db.prepare('UPDATE g_kullanici SET rol=? WHERE id=?').bind(rol, id).run(); break; }
    case 'sil':
      await db.batch([oturumSil, db.prepare('DELETE FROM g_giris WHERE kullanici_id=?').bind(id), db.prepare('DELETE FROM g_izleme WHERE kullanici_id=?').bind(id), db.prepare('DELETE FROM g_kullanici WHERE id=?').bind(id)]); break;
    default: throw new Hata(400, 'Bilinmeyen işlem.');
  }
  return { tamam: true };
}

const UCLAR = {
  'POST /kayit': kayit, 'POST /giris': giris, 'GET /ben': ben, 'POST /cikis': cikis, 'POST /nabiz': nabiz, 'POST /ziyaret': ziyaret,
  'GET /ozel': ozelOku, 'POST /ozel': ozelYaz,
  'GET /yonetim/ozet': yOzet, 'POST /yonetim/kullanici': yKullanici, 'POST /yonetim/islem': yIslem,
};

export default {
  async fetch(req, env) {
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);
    const uc = UCLAR[req.method + ' ' + url.pathname];
    if (!uc) return json({ hata: 'Bulunamadı' }, 404, h);
    try {
      const db = env.filmx_db; await kur(db);
      let v = {};
      if (req.method === 'POST') {
        const metin = await req.text();
        if (metin.length > 1000000) throw new Hata(413, 'İstek çok büyük.');
        try { v = metin ? JSON.parse(metin) : {}; } catch (e) { throw new Hata(400, 'Geçersiz istek.'); }
        if (!v || typeof v !== 'object') v = {};
      }
      return json(await uc(req, env, db, v), 200, h);
    } catch (e) {
      if (e instanceof Hata) return json({ hata: e.message }, e.kod, h);
      console.error(e && e.stack || e);
      return json({ hata: 'Sunucu hatası. Biraz sonra tekrar deneyin.' }, 500, h);
    }
  },
};
