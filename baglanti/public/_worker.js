// Yedek bağlantı (Cloudflare Pages, filmx-baglanti.pages.dev): bazı mobil operatörler/VPN'ler *.workers.dev'i engelliyor.
// /g/... -> filmx-giris, /m/... -> filmx-mac, /r/... -> filmx-robot (servis bağlaması; istek başlıkları, Origin ve IP aynen gider)
const YOL = { g: 'GIRIS', m: 'MAC', r: 'ROBOT' };
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const [, on, ...kalan] = u.pathname.split('/');
    const hedef = env[YOL[on]];
    if (!hedef) return new Response('FilmX', { status: 404 });
    u.pathname = '/' + kalan.join('/');
    return hedef.fetch(new Request(u.toString(), req));
  }
};
