// FilmX Maçlar: maç yayın sitesinin kanal listesini okuyup sade JSON olarak verir.
// Sayfa siteyi doğrudan okuyamaz (CORS yok); bu Worker aracılık eder. Reklam/banner verisi hiç aktarılmaz.
//
// GET /liste -> { oynatici: "https://.../index.php", guncel: 1727.., sekmeler: [{ ad, kanallar: [{ ad, saat, id, tur }] }] }

const SEKMELER = [
  { id: 'tab1', ad: 'Futbol' },
  { id: 'tab2', ad: 'Basketbol' },
  { id: 'tab3', ad: 'Tenis' },
  { id: 'tab5', ad: '7/24 TV' },
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const ONBELLEK_SN = 90;

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

const VARLIK = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const metin = s => s.replace(/<[^>]*>/g, '').replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, k) => {
  if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : +k.slice(1));
  return VARLIK[k.toLowerCase()] ?? m;
}).replace(/\s+/g, ' ').trim();

function ayikla(html) {
  let oynatici = '';
  const sekmeler = [];
  for (const sk of SEKMELER) {
    const bas = html.indexOf(`id="${sk.id}"`);
    if (bas < 0) continue;
    const son = html.indexOf('data-tab-content', bas + 10);
    const parca = html.slice(bas, son < 0 ? undefined : son);
    const kanallar = [];
    const re = /<li[^>]*>\s*<a[^>]*data-url="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(parca))) {
      let u;
      try { u = new URL(m[1].replace(/&amp;/g, '&')); } catch (e) { continue; }
      const id = u.searchParams.get('id');
      if (!id || !/^[\w-]{2,80}$/.test(id)) continue;
      if (!oynatici) oynatici = u.origin + u.pathname;
      const ic = m[2];
      const ad = metin((ic.match(/<div class="name">([\s\S]*?)<\/div>/) || [])[1] || '');
      const saat = metin((ic.match(/<time[^>]*>([\s\S]*?)<\/time>/) || [])[1] || '');
      const ikon = (ic.match(/icon-([a-z-]+)/) || [])[1] || '';
      const tur = /basket/.test(ikon) ? 'basketbol' : /tennis/.test(ikon) ? 'tenis' : /tv/.test(ikon) ? 'tv' : 'futbol';
      if (ad) kanallar.push({ ad, saat, id, tur });
    }
    sekmeler.push({ ad: sk.ad, kanallar });
  }
  return { oynatici, sekmeler };
}

async function listeGetir(env) {
  const adresler = (env.SITE_ADRESLERI || '').split(',').map(s => s.trim()).filter(Boolean);
  let sonHata = 'site adresi tanımlı değil';
  for (const adres of adresler) {
    try {
      const r = await fetch(adres, { headers: { 'User-Agent': UA, 'Accept-Language': 'tr-TR,tr;q=0.9' }, redirect: 'follow', cf: { cacheTtl: 0 } });
      if (!r.ok) { sonHata = adres + ' -> HTTP ' + r.status; continue; }
      const veri = ayikla(await r.text());
      if (veri.oynatici && veri.sekmeler.some(s => s.kanallar.length)) return { ...veri, guncel: Date.now() };
      sonHata = adres + ' -> liste bulunamadı';
    } catch (e) { sonHata = adres + ' -> ' + e.message; }
  }
  throw new Error(sonHata);
}

export default {
  async fetch(req, env, ctx) {
    const b = basliklar(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: b });
    const url = new URL(req.url);
    if (url.pathname !== '/liste') return new Response(JSON.stringify({ hata: 'yok' }), { status: 404, headers: b });

    const onbellek = caches.default;
    const anahtar = new Request(url.origin + '/liste');
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
