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
const sayac = new Map();              // IP -> [zamanlar] (aynı Worker örneği içinde)

function cors(req, env) {
  const izinli = (env.IZINLI_ADRESLER || 'http://127.0.0.1:8791,null').split(',').map(s => s.trim());
  const o = req.headers.get('Origin') || 'null';
  return {
    'Access-Control-Allow-Origin': izinli.includes(o) || izinli.includes('*') ? o : izinli[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-FilmX-Anahtar',
    'Vary': 'Origin',
  };
}
const json = (veri, durum, h) => new Response(JSON.stringify(veri), { status: durum, headers: { 'Content-Type': 'application/json; charset=utf-8', ...h } });

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

export default {
  async fetch(req, env, ctx) {
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { headers: h });
    if (req.method !== 'POST') return json({ hata: 'Sadece POST' }, 405, h);
    if (env.ERISIM_ANAHTARI && req.headers.get('X-FilmX-Anahtar') !== env.ERISIM_ANAHTARI) return json({ hata: 'yetkisiz' }, 401, h);

    const ip = req.headers.get('CF-Connecting-IP') || 'yerel';
    if (sinirAsildi(ip)) return json({ cevap: 'Biraz hızlı gidiyoruz 🙂 Bir dakika sonra tekrar sorar mısın?', oneriler: [], kategori: '' }, 200, h);

    let g; try { g = await req.json(); } catch (e) { return json({ hata: 'geçersiz istek' }, 400, h); }
    if (g.islem === 'bilgi') return json(await bilgiBul(g), 200, h);
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
