// FilmX Maçlar: maç sitesinin liste dosyasını (JS) okuyup sade JSON verir. Sayfa siteyi doğrudan okuyamaz (CORS yok).
// Liste: SITE_LISTE (futbolMatches / basketbolMatches / voleybolMatches / tenisMatches / channels dizileri)
// Video tabanları: SITE_OYNATICI sayfasındaki baseurls (sırayla; biri 403 verirse sayfa sıradakine geçer). Video = taban + kimlik + ".m3u8"
// Reklam/banner verisi hiç aktarılmaz; liste dosyası ÇALIŞTIRILMAZ, sadece metin olarak ayrıştırılır.
//
// GET /liste -> { tabanlar: [..], maclar: [{ saat, lig, ad, id, canli, spor }], kanallar: [{ ad, id }], guncel }

const SPORLAR = { futbolMatches: 'futbol', basketbolMatches: 'basketbol', voleybolMatches: 'voleybol', tenisMatches: 'tenis' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const ONBELLEK_SN = 60;

function basliklar(req, env) {
  const izinli = (env.IZINLI_ADRESLER || '').split(',').map(s => s.trim()).filter(Boolean);
  const o = req.headers.get('Origin') || 'null';
  return {
    'Access-Control-Allow-Origin': izinli.includes(o) ? o : (izinli[0] || 'null'),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
  };
}

// "ad = [ ... ];" dizisini çalıştırmadan JSON olarak ayrıştırır (tırnaksız anahtarlar ve sondaki virgüller düzeltilir)
function dizi(js, ad) {
  const m = js.match(new RegExp('\\b' + ad + '\\s*=\\s*\\['));
  if (!m) return [];
  let i = m.index + m[0].length - 1, d = 0, tirnak = '', e = i;
  for (; e < js.length; e++) {
    const c = js[e];
    if (tirnak) { if (c === '\\') e++; else if (c === tirnak) tirnak = ''; continue; }
    if (c === '"' || c === "'") tirnak = c;
    else if (c === '[' || c === '{') d++;
    else if ((c === ']' || c === '}') && --d === 0) break;
  }
  const govde = js.slice(i, e + 1)
    .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (x, s) => JSON.stringify(s.replace(/\\'/g, "'")))
    .replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(govde); } catch (e) { return []; }
}
const kimlik = u => { const m = String(u || '').match(/[?&]id=([\w-]{2,80})/); return m ? m[1] : ''; };

async function listeGetir(env) {
  const liste = env.SITE_LISTE, oynatici = env.SITE_OYNATICI;
  if (!liste || !oynatici) throw new Error('site adresi tanımlı değil');
  const [lr, or] = await Promise.all([
    fetch(liste, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 0 } }),
    fetch(oynatici, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 300 } }),
  ]);
  if (!lr.ok) throw new Error('liste -> HTTP ' + lr.status);
  const js = await lr.text(), oh = or.ok ? await or.text() : '';
  const tabanlar = [...new Set([...oh.matchAll(/"(https:\/\/[^"\s]+\/checklist\/)"/g)].map(m => m[1]))];
  const maclar = [];
  for (const [ad, spor] of Object.entries(SPORLAR)) for (const x of dizi(js, ad)) {
    const id = kimlik(x.url); if (!id) continue;
    maclar.push({ saat: String(x.time || ''), lig: String(x.league || ''), ad: String(x.title || ''), id, canli: !!x.live, spor });
  }
  const kanallar = dizi(js, 'channels').map(x => ({ ad: String(x.title || ''), id: kimlik(x.url) })).filter(x => x.id && x.ad);
  if (!tabanlar.length || (!maclar.length && !kanallar.length)) throw new Error('liste ya da video tabanı bulunamadı');
  return { tabanlar, maclar, kanallar, guncel: Date.now() };
}

export default {
  async fetch(req, env, ctx) {
    const b = basliklar(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: b });
    const url = new URL(req.url);
    if (url.pathname !== '/liste') return new Response(JSON.stringify({ hata: 'yok' }), { status: 404, headers: b });

    const onbellek = caches.default;
    const anahtar = new Request(url.origin + '/liste-v2');
    let yanit = await onbellek.match(anahtar);
    if (!yanit) {
      try {
        const veri = await listeGetir(env);
        yanit = new Response(JSON.stringify(veri), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=' + ONBELLEK_SN } });
        ctx.waitUntil(onbellek.put(anahtar, yanit.clone()));
      } catch (e) {
        return new Response(JSON.stringify({ hata: 'Maç listesi alınamadı', ayrinti: String(e.message || e) }), { status: 502, headers: b });
      }
    }
    return new Response(yanit.body, { status: 200, headers: b });
  },
};
