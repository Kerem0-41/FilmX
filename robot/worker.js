// FilmX Film Robotu — Cloudflare Worker (arka uç)
// Gemini anahtarı yalnızca burada, gizli değişken olarak durur (GEMINI_KEY). Sayfaya/GitHub'a hiç girmez.
// Model sırası: kotası yüksek ucuz modellerden başlar; biri hata/kota verirse aynı soru sessizce sıradakine gider.

const MODELLER = [
  'gemini-3.5-flash-lite',   // hızlı, ucuz, günlük kotası yüksek
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash',        // daha güçlü, kotası daha düşük
  'gemini-2.5-flash',
  'gemma-4-31b-it',          // son çare: kotası çok yüksek açık modeller
  'gemma-4-26b-a4b-it',
];

const KATEGORILER = ['aksiyon', 'komedi', 'korku', 'gerilim', 'bilimkurgu', 'animasyon', 'dram', 'romantik', 'fantastik', 'suc', 'savas', 'belgesel', 'marvel', 'dizi'];

const TALIMAT = `Sen FilmX'in "Film Robotu"sun. Türkçe, samimi ve kısa konuşursun.
Kullanıcı bir film/dizi adı, tür, oyuncu, konu, sahne ya da "şuna benzer ne izleyeyim" gibi herhangi bir şey sorabilir.
- Film veya dizi öneriyorsan ya da birinden bahsediyorsan, her birini "oneriler" listesine yaz.
- "ad" alanına Türkiye'de bilinen Türkçe adını, "orijinal" alanına orijinal adını yaz; "yil" ve "tur" ("film" ya da "dizi") ekle.
- Konu bir türe denk geliyorsa "kategori" alanına şu anahtarlardan birini yaz, değilse boş bırak: ${KATEGORILER.join(', ')}.
- Film dışı konulara kısa ve nazikçe filmlere döndürerek cevap ver. Emin olmadığın bilgiyi uydurma.
- "cevap" en fazla 5-6 cümle olsun.
Cevabı SADECE şu JSON biçiminde ver, başka hiçbir şey yazma:
{"cevap":"...","oneriler":[{"ad":"...","orijinal":"...","yil":2010,"tur":"film"}],"kategori":""}`;

const ONBELLEK_SN = 60 * 60 * 24;     // aynı soru 1 gün önbellekten cevaplanır
const DAKIKA_SINIRI = 12;             // kişi (IP) başına dakikada en fazla soru
const GECMIS_MESAJ = 8;               // modele gönderilen en fazla eski mesaj
const sayac = new Map();
const GUNLUK_SINIR = 400;              // robot için günde en fazla soru (tüm kullanıcılar)              // IP -> [zamanlar] (aynı Worker örneği içinde)

function cors(req, env) {
  const izinli = (env.IZINLI_ADRESLER || 'http://127.0.0.1:8791,null').split(',').map(s => s.trim());
  const o = req.headers.get('Origin') || 'null';
  return {
    'Access-Control-Allow-Origin': izinli.includes(o) || izinli.includes('*') ? o : izinli[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}
const json = (veri, durum, h) => new Response(JSON.stringify(veri), { status: durum, headers: { 'Content-Type': 'application/json; charset=utf-8', ...h } });

// günlük toplam sınır: filmx-db (D1) içinde gün gün sayılır
async function gunlukSinirAsildi(env) {
  if (!env.filmx_db) return false;
  const gun = new Date().toISOString().slice(0, 10);
  try {
    await env.filmx_db.prepare('CREATE TABLE IF NOT EXISTS sayac (gun TEXT PRIMARY KEY, adet INTEGER NOT NULL)').run();
    const r = await env.filmx_db.prepare('INSERT INTO sayac (gun, adet) VALUES (?, 1) ON CONFLICT(gun) DO UPDATE SET adet = adet + 1 RETURNING adet').bind(gun).first();
    return (r && r.adet) > GUNLUK_SINIR;
  } catch (e) { return false; }
}

function sinirAsildi(ip) {
  const simdi = Date.now(), l = (sayac.get(ip) || []).filter(t => simdi - t < 60000);
  l.push(simdi); sayac.set(ip, l);
  return l.length > DAKIKA_SINIRI;
}

function ayikla(metin) {
  // model JSON'u kod bloğuna sarabilir ya da başına/sonuna yazı ekleyebilir
  const t = (metin || '').replace(/```json|```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) return { cevap: t.trim(), oneriler: [], kategori: '' };
  try {
    const j = JSON.parse(t.slice(a, b + 1));
    return {
      cevap: String(j.cevap || '').slice(0, 1500),
      oneriler: (Array.isArray(j.oneriler) ? j.oneriler : []).slice(0, 8).map(o => ({
        ad: String(o.ad || '').slice(0, 120), orijinal: String(o.orijinal || '').slice(0, 120),
        yil: +o.yil || 0, tur: o.tur === 'dizi' ? 'dizi' : 'film' })).filter(o => o.ad || o.orijinal),
      kategori: KATEGORILER.includes(j.kategori) ? j.kategori : '',
    };
  } catch (e) { return { cevap: t.trim().slice(0, 1500), oneriler: [], kategori: '' }; }
}

async function modeleSor(model, icerik, env) {
  const gemma = model.startsWith('gemma');
  const govde = {
    contents: gemma ? [{ role: 'user', parts: [{ text: TALIMAT }] }, { role: 'model', parts: [{ text: '{"cevap":"Tamam.","oneriler":[],"kategori":""}' }] }, ...icerik] : icerik,
    generationConfig: { temperature: 0.7, maxOutputTokens: 900, ...(gemma ? {} : { responseMimeType: 'application/json' }) },
  };
  if (!gemma) govde.systemInstruction = { parts: [{ text: TALIMAT }] };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY }, body: JSON.stringify(govde),
  });
  if (!r.ok) throw new Error(model + ' ' + r.status);
  const j = await r.json();
  const metin = ((j.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!metin.trim()) throw new Error(model + ' boş cevap');
  return metin;
}

// "Link Ekle" için: film/dizi adından afiş + yıl + IMDb kimliği (IMDb öneri servisi; sayfadan CORS yüzünden doğrudan çağrılamıyor)
async function bilgiBul(g) {
  const ad = String(g.ad || '').trim().slice(0, 120); if (!ad) return { bulundu: false };
  const dizi = g.tur === 'dizi';
  const q = ad.toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9 ]+/g, ' ').trim();
  try {
    const r = await fetch('https://v3.sg.media-imdb.com/suggestion/x/' + encodeURIComponent(q) + '.json', { cf: { cacheTtl: 86400 } });
    const j = await r.json();
    const uygun = (j.d || []).filter(x => /^tt/.test(x.id) && (dizi ? /tvSeries|tvMiniSeries/.test(x.qid || '') : /movie|tvMovie|video/.test(x.qid || '')));
    const x = uygun.find(x => !g.yil || !x.y || Math.abs(x.y - +g.yil) <= 1) || uygun[0];
    if (!x) return { bulundu: false };
    return { bulundu: true, imdb: x.id, ad: x.l, yil: x.y || '', afis: x.i && x.i.imageUrl ? x.i.imageUrl.replace(/\._V1_.*\.jpg$/, '._V1_QL75_UX500_.jpg') : '', oyuncular: x.s || '' };
  } catch (e) { return { bulundu: false }; }
}

// ---------- Giriş (tek yönetici hesabı) ----------
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
async function hmac(anahtar, veri) { const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(anahtar), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return b64u(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(veri))); }
async function sifreDogru(sifre, kayit) {   // kayit = "tuz:hash" (PBKDF2-SHA256, 100000 tur)
  const [tuz, beklenen] = String(kayit || "").split(":"); if (!tuz || !beklenen) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(sifre), "PBKDF2", false, ["deriveBits"]);
  const bit = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(tuz), iterations: 100000, hash: "SHA-256" }, k, 256);
  const h = hex(bit); let fark = h.length ^ beklenen.length; for (let i = 0; i < h.length; i++) fark |= h.charCodeAt(i) ^ (beklenen.charCodeAt(i) || 0); return fark === 0;
}
async function oturumVer(env) { const yuk = b64u(new TextEncoder().encode(JSON.stringify({ r: "admin", exp: Date.now() + 30 * 864e5 }))); return yuk + "." + await hmac(env.OTURUM_ANAHTARI, yuk); }
async function oturumDogru(env, token) {
  const [yuk, imza] = String(token || "").split("."); if (!yuk || !imza || !env.OTURUM_ANAHTARI) return false;
  if (await hmac(env.OTURUM_ANAHTARI, yuk) !== imza) return false;
  try { const v = JSON.parse(atob(yuk.replace(/-/g, "+").replace(/_/g, "/"))); return v.exp > Date.now(); } catch (e) { return false; }
}
async function denemeFazla(env, ip, yanlis) {   // 15 dk içinde 8 yanlış deneme -> kilit
  if (!env.filmx_db) return false;
  await env.filmx_db.prepare("CREATE TABLE IF NOT EXISTS giris_deneme (ip TEXT, zaman INTEGER)").run();
  const sinir = Date.now() - 15 * 60000;
  if (yanlis) await env.filmx_db.prepare("INSERT INTO giris_deneme (ip, zaman) VALUES (?, ?)").bind(ip, Date.now()).run();
  const r = await env.filmx_db.prepare("SELECT COUNT(*) AS n FROM giris_deneme WHERE ip = ? AND zaman > ?").bind(ip, sinir).first();
  return (r && r.n) >= 8;
}

// ---------- Türkçe altyazı (oynat.html) ----------
// Oynatıcı videoyu izlerken sesi ~30 sn'lik parçalar halinde yollar (video sunucudan geçmez). Gemini yazıya döker + Türkçeye çevirir,
// D1'e kaydedilir; sonraki izleyiciler hazır altyazıyı alır. k = videonun kimliği (oynatıcı adresinden türetilir).
const SES_MODELLER = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'];
// hakkı biten (429) ya da olmayan (404) sürüm bir süre atlanır, her istekte boşuna denenmez: model -> tekrar denenebileceği zaman
const SES_DINLEN = new Map();
const ALT_TALIMAT = `Bu bir film/dizi ses parçası. Görevin: Türkçe altyazı üretmek.
Konuşulan her cümleyi dinle ve TÜRKÇE'ye ÇEVİREREK yaz. Konuşma İngilizce ya da başka bir dildeyse ASLA o dilde yazma, mutlaka Türkçe çevirisini yaz.
Konuşma zaten Türkçeyse olduğu gibi yaz. Müzik/sessizlik için bir şey yazma. Zamanlar parçanın başından itibaren saniye cinsinden olsun.
SADECE şu JSON'u ver: [{"b":1.2,"s":3.4,"m":"Türkçe cümle"}]  (boşsa [])`;
async function altTablo(env) { await env.filmx_db.prepare('CREATE TABLE IF NOT EXISTS altyazi (k TEXT, bas INTEGER, veri TEXT, PRIMARY KEY (k, bas))').run(); }

// Gemini bazen çevirmeden (İngilizce) yazıyor: satırlar Türkçe değilse Google Translate ile çevrilir
const TR_HARF = /[çğıöşüÇĞİÖŞÜ]/, TR_KELIME = /\b(bir|ve|bu|ne|ben|sen|evet|hayır|değil|için|çok|var|yok|mi|mı|mu|mü|da|de|ki|şey|tamam|neden|nasıl)\b/i;
const EN_KELIME = /\b(the|you|is|are|and|what|i'm|don't|it's|that|this|was|have|your|not|with|of|to|me|my|we|he|she|they|yes|no|okay|oh)\b/i;
function turkceMi(satirlar) {
  if (!satirlar.length) return true;
  let tr = 0, en = 0;
  for (const x of satirlar) { if (TR_HARF.test(x.m) || TR_KELIME.test(x.m)) tr++; else if (EN_KELIME.test(x.m)) en++; }
  return en <= tr;
}
async function turkceyeCevir(satirlar) {
  const AYRAC = '\n';   // satırlar tek istekte, sırası korunarak çevrilir
  const metin = satirlar.map(x => x.m.replace(/\n/g, ' ')).join(AYRAC);
  const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&q=' + encodeURIComponent(metin));
  if (!r.ok) return satirlar;
  const j = await r.json();
  const cikti = (j[0] || []).map(p => p[0] || '').join('').split(AYRAC);
  if (cikti.length !== satirlar.length) return satirlar;
  return satirlar.map((x, i) => ({ ...x, m: cikti[i].trim() || x.m }));
}
// yedek: Google Translate engellerse Gemini'nin yazı modeli çevirir (yalnız yazı; ses yok, çok ucuz)
async function geminiCevir(satirlar, env) {
  const metin = JSON.stringify(satirlar.map(x => x.m));
  for (const model of ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.5-flash']) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Bu film altyazı satırlarını Türkçeye çevir. Aynı sırada, aynı sayıda, SADECE JSON dizi ver:\n' + metin }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 4000, responseMimeType: 'application/json' } }) });
      if (!r.ok) continue;
      const j = await r.json();
      const t = ((j.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('');
      const c = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
      if (Array.isArray(c) && c.length === satirlar.length) return satirlar.map((x, i) => ({ ...x, m: String(c[i] || x.m).slice(0, 300) }));
    } catch (e) { /* sıradaki model */ }
  }
  return satirlar;
}
// kaynağın yazılı altyazısı (ör. İngilizce) -> Türkçe. Ses yok, yalnız yazı. Aynı satırlar 30 gün önbellekte.
async function metinCevir(env, g, ctx) {
  const l = (Array.isArray(g.satirlar) ? g.satirlar : []).slice(0, 100).map(x => String(x || '').slice(0, 300));
  if (!l.length) return { ceviri: [] };
  const ozet = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(l)));
  const anahtar = new Request('https://filmx-robot.onbellek/cevir/' + [...new Uint8Array(ozet)].map(b => b.toString(16).padStart(2, '0')).join(''));
  const c = await caches.default.match(anahtar); if (c) return await c.json();
  const satirlar = l.map(m => ({ m }));
  let son = satirlar; try { son = await turkceyeCevir(satirlar); } catch (e) {}
  if (son === satirlar || son.every((x, i) => x.m === l[i])) son = await geminiCevir(satirlar, env);
  const cevap = { ceviri: son.map(x => x.m) };
  if (son !== satirlar) ctx.waitUntil(caches.default.put(anahtar, new Response(JSON.stringify(cevap), { headers: { 'Cache-Control': 'max-age=2592000' } })));
  return cevap;
}
async function duzelt(satirlar, env) {
  if (turkceMi(satirlar)) return satirlar;
  let l = satirlar; try { l = await turkceyeCevir(satirlar); } catch (e) {}
  if (!turkceMi(l) && env) l = await geminiCevir(satirlar, env);
  return l;
}

async function altyaziAl(env, g, ctx) {
  const k = String(g.k || '').slice(0, 300); if (!k || !env.filmx_db) return { satirlar: [], parcalar: [] };
  await altTablo(env);
  const r = await env.filmx_db.prepare('SELECT bas, veri FROM altyazi WHERE k = ? ORDER BY bas').bind(k).all();
  const satirlar = [], parcalar = [], bozuk = [];
  for (const x of r.results || []) {
    let l = []; try { l = JSON.parse(x.veri); } catch (e) {}
    if (!turkceMi(l)) { bozuk.push({ bas: x.bas, l }); continue; }   // İngilizce kalmış eski kayıt: bekletmeden arkada düzeltilir
    parcalar.push(x.bas); satirlar.push(...l);
  }
  if (bozuk.length && ctx) ctx.waitUntil((async () => {
    for (const b of bozuk.slice(0, 20)) {
      const l = await duzelt(b.l, env);
      if (turkceMi(l)) await env.filmx_db.prepare('UPDATE altyazi SET veri = ? WHERE k = ? AND bas = ?').bind(JSON.stringify(l), k, b.bas).run();
      else await env.filmx_db.prepare('DELETE FROM altyazi WHERE k = ? AND bas = ?').bind(k, b.bas).run();   // düzelmediyse silinir, yeniden hazırlanır
    }
  })());
  return { satirlar, parcalar };
}
async function altyaziParca(env, g) {
  const k = String(g.k || '').slice(0, 300), bas = Math.max(0, Math.round(+g.bas || 0)), ses = String(g.ses || ''), mime = String(g.mime || 'audio/webm').split(';')[0];
  if (!k || !ses || ses.length > 8_000_000 || !env.filmx_db) return { ok: false };
  await altTablo(env);
  const var_ = await env.filmx_db.prepare('SELECT veri FROM altyazi WHERE k = ? AND bas = ?').bind(k, bas).first();
  if (var_) return { ok: true, satirlar: JSON.parse(var_.veri) };
  // birden çok anahtar: GEMINI_KEY, GEMINI_KEY2..GEMINI_KEY9 — birinin kotası bitince sıradakiyle devam (bölüm ortasında altyazı kesilmesin)
  const anahtarlar = [env.GEMINI_KEY, ...[2, 3, 4, 5, 6, 7, 8, 9].map(i => env['GEMINI_KEY' + i])].filter(Boolean);
  const simdi = Date.now(), hepsi = [];
  for (const model of SES_MODELLER) anahtarlar.forEach((key, ki) => hepsi.push({ model, key, ad: model + '#' + ki }));
  const sira = hepsi.filter(x => !(SES_DINLEN.get(x.ad) > simdi));
  for (const { model, key, ad } of (sira.length ? sira : hepsi)) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: ses } }, { text: ALT_TALIMAT }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 4000, responseMimeType: 'application/json' } }) });
      if (!r.ok) { if (r.status === 429) SES_DINLEN.set(ad, Date.now() + 10 * 60000); else if (r.status === 404) SES_DINLEN.set(ad, Date.now() + 24 * 3600000); continue; }
      const j = await r.json();
      const t = ((j.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('').replace(/```json|```/g, '');
      const a = t.indexOf('['), b = t.lastIndexOf(']'); if (a < 0) continue;
      const satirlar = await duzelt(JSON.parse(t.slice(a, b + 1)).map(x => ({ b: +(bas + (+x.b || 0)).toFixed(2), s: +(bas + (+x.s || (+x.b || 0) + 2)).toFixed(2), m: String(x.m || '').slice(0, 300) })).filter(x => x.m), env);
      await env.filmx_db.prepare('INSERT OR REPLACE INTO altyazi (k, bas, veri) VALUES (?, ?, ?)').bind(k, bas, JSON.stringify(satirlar)).run();
      return { ok: true, satirlar };
    } catch (e) { /* sıradaki model */ }
  }
  return { ok: false };
}

export default {
  async fetch(req, env, ctx) {
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { headers: h });
    if (req.method !== 'POST') return json({ hata: 'Sadece POST' }, 405, h);
    if (false && await gunlukSinirAsildi(env)) return json({ cevap: 'Bugünlük soru hakkım doldu 🙂 Yarın tekrar konuşalım!', oneriler: [], kategori: '' }, 200, h);

    const ip = req.headers.get('CF-Connecting-IP') || 'yerel';
    if (new URL(req.url).pathname === '/altyazi') {
      let a; try { a = await req.json(); } catch (e) { return json({ hata: 'geçersiz istek' }, 400, h); }
      if (a.islem === 'al') return json(await altyaziAl(env, a, ctx), 200, h);
      if (a.islem === 'parca') return json(await altyaziParca(env, a), 200, h);
      if (a.islem === 'cevir') return json(await metinCevir(env, a, ctx), 200, h);
      return json({ hata: 'bilinmeyen' }, 400, h);
    }
    if (sinirAsildi(ip)) return json({ cevap: 'Biraz hızlı gidiyoruz 🙂 Bir dakika sonra tekrar sorar mısın?', oneriler: [], kategori: '' }, 200, h);

    let g; try { g = await req.json(); } catch (e) { return json({ hata: 'geçersiz istek' }, 400, h); }
    const ipAdr = req.headers.get('CF-Connecting-IP') || 'yerel';
    if (g.islem === 'giris') {
      if (await denemeFazla(env, ipAdr, false)) return json({ ok: false, hata: 'Çok fazla deneme. 15 dakika sonra tekrar deneyin.' }, 429, h);
      const dogru = String(g.kullanici || '') === env.ADMIN_KULLANICI && await sifreDogru(String(g.sifre || ''), env.ADMIN_SIFRE);
      if (!dogru) { await denemeFazla(env, ipAdr, true); return json({ ok: false, hata: 'Kullanıcı adı veya şifre yanlış.' }, 401, h); }
      return json({ ok: true, token: await oturumVer(env) }, 200, h);
    }
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    // oturum zorunluluğu şimdilik kapalı (sayfada giriş ekranı yok); GIRIS_ZORUNLU tanımlanırsa açılır
    if (env.GIRIS_ZORUNLU && !(await oturumDogru(env, token))) return json({ ok: false, hata: 'oturum gerekli' }, 401, h);
    if (g.islem === 'oturum') return json({ ok: true }, 200, h);
    if (g.islem === 'bilgi') return json(await bilgiBul(g), 200, h);
    if (g.islem !== 'bilgi' && await gunlukSinirAsildi(env)) return json({ cevap: 'Bugünlük soru hakkım doldu 🙂 Yarın tekrar konuşalım!', oneriler: [], kategori: '' }, 200, h);
    const soru = String(g.soru || '').trim().slice(0, 600);
    if (!soru) return json({ hata: 'soru boş' }, 400, h);
    const gecmis = (Array.isArray(g.gecmis) ? g.gecmis : []).slice(-GECMIS_MESAJ)
      .map(m => ({ role: m.rol === 'robot' ? 'model' : 'user', parts: [{ text: String(m.metin || '').slice(0, 800) }] }));

    // aynı soru (geçmişsiz) önbellekte varsa kota harcamadan dön
    const cache = caches.default;
    const anahtar = new Request('https://filmx-robot.onbellek/' + encodeURIComponent(soru.toLocaleLowerCase('tr')));
    if (!gecmis.length) { const c = await cache.match(anahtar); if (c) return json(await c.json(), 200, h); }

    const icerik = [...gecmis, { role: 'user', parts: [{ text: soru }] }];
    for (const model of MODELLER) {
      try {
        const sonuc = ayikla(await modeleSor(model, icerik, env));
        if (!sonuc.cevap && !sonuc.oneriler.length) continue;
        if (!gecmis.length) ctx.waitUntil(cache.put(anahtar, new Response(JSON.stringify(sonuc), { headers: { 'Cache-Control': 'max-age=' + ONBELLEK_SN } })));
        return json(sonuc, 200, h);
      } catch (e) { /* kota/hata: sessizce sıradaki modele geç */ }
    }
    return json({ cevap: 'Şu an çok yoğunum, birazdan tekrar dener misin? 🎬', oneriler: [], kategori: '' }, 200, h);
  },
};
