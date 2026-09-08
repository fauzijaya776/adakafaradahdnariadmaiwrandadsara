// Cloudflare Pages Function — route: /callback (mis. https://alimcloud.id/callback)
//
// Fungsi ini MENERUSKAN (proxy) callback QRIN apa adanya ke bot di Render:
// body mentah + header X-Callback-Signature tidak diubah, sehingga tanda tangan
// HMAC-SHA256 tetap sah di sisi bot.
//
// URL tujuan diambil dari Environment Variable Pages: RENDER_CALLBACK_URL
// (set di dashboard: Workers & Pages -> alimcloud -> Settings -> Variables).
// Kalau belum diisi, dipakai nilai fallback di bawah — GANTI dengan URL Render Anda.

const FALLBACK_RENDER_URL = 'https://GANTI-URL-RENDER.onrender.com/callback';

export async function onRequestPost(context) {
  const { request, env } = context;
  const target = (env && env.RENDER_CALLBACK_URL) || FALLBACK_RENDER_URL;

  try {
    // Body mentah apa adanya (jangan di-parse) supaya tanda tangan tetap cocok.
    const rawBody = await request.arrayBuffer();
    const signature = request.headers.get('X-Callback-Signature') || '';

    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Callback-Signature': signature,
      },
      body: rawBody,
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    // Render tak terjangkau / cold-start. Balas 502 supaya QRIN mengulang.
    return new Response(
      JSON.stringify({ success: false, message: 'Upstream error: ' + (err && err.message) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// QRIN memakai POST. GET hanya untuk cek cepat di browser.
export async function onRequestGet() {
  return new Response(
    JSON.stringify({ success: false, message: 'Method not allowed (gunakan POST)' }),
    { status: 405, headers: { 'Content-Type': 'application/json' } }
  );
}
