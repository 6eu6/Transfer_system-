/* Live Yemeni rial rates for Aden and Sanaa.

   The global FX feeds carry a YER number near 237 to the dollar. That is
   the pre-war official rate; it has not been a price anyone trades at for
   years. Aden sits near 1,560 and Sanaa near 534 — a factor of six away
   from the feed, and nearly three times apart from each other. So Yemen
   needs its own source, and Yemeni sources are HTML pages, not APIs.

   A browser cannot read most of them: only 2dec sends CORS headers, and
   it is the one whose own timestamp lags. Hence this function — a server
   has no CORS to satisfy, so it can read all of them, cross-check, and
   hand the page a single number it is allowed to trust.

   Freshness is never taken from a source's own claim. It is inferred from
   two independent sources agreeing; where they don't, the caller is told. */

const strip = s => s.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
const txt   = s => strip(s).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
const n     = s => parseFloat(String(s).replace(/,/g, ""));

async function get(url){
  const r = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; hawala-desk/1.0)" },
    signal: AbortSignal.timeout(9000)
  });
  if(!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.text();
}

/* exrye — one page per city, plain figures, currently the freshest */
async function exrye(city){
  const t = txt(await get("https://exrye.com/" + city));
  const grab = label => {
    const m = t.match(new RegExp(label + "\\s*\\(([A-Z]{3})\\)\\s*([\\d,.]+)\\s*([\\d,.]+)"));
    return m ? { buy: n(m[2]), sell: n(m[3]) } : null;
  };
  const USD = grab("الدولار الأمريكي");
  if(!USD) throw new Error("exrye/" + city + ": تغيّرت بنية الصفحة");
  return { USD, SAR: grab("الريال السعودي") };
}

/* 2dec — both cities in one table; its stamp is kept for display only */
async function twodec(){
  const html = await get("https://www.2dec.net/rate.html");
  const rows = strip(html).match(/<tr[\s\S]*?<\/tr>/g) || [];
  const cells = r => [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
  const pick = re => rows.map(cells).filter(c => c.length >= 3 && re.test(c[0]));

  const usd = pick(/دولار امريكي/);
  const sar = pick(/ريال سعودي/);
  if(usd.length < 2) throw new Error("2dec: تغيّرت بنية الجدول");

  /* the table lists Sanaa first, then Aden; columns are sell · trend · buy */
  const row = c => ({ sell: n(c[1]), buy: n(c[3]) });
  return {
    sanaa: { USD: row(usd[0]), SAR: sar[0] ? row(sar[0]) : null },
    aden:  { USD: row(usd[1]), SAR: sar[1] ? row(sar[1]) : null },
    stamp: [...html.matchAll(/(\d{2}:\d{2}:\d{2})\s*(\d{4}-\d{2}-\d{2})/g)].map(m => `${m[2]} ${m[1]}`)
  };
}

/* Two readings of the same market: agree and it is trustworthy, disagree
   and the caller gets the spread instead of a tidy average that hides it. */
function cross(a, b){
  const vals = [a, b].filter(v => typeof v === "number" && v > 0);
  if(vals.length === 2){
    const gap = Math.abs(vals[0] / vals[1] - 1) * 100;
    return {
      rate: (vals[0] + vals[1]) / 2,
      gap: +gap.toFixed(2),
      sources: 2,
      confidence: gap < 2 ? "مؤكَّد" : "المصادر متباعدة — راجع الصرّاف"
    };
  }
  if(vals.length === 1) return { rate: vals[0], gap: null, sources: 1, confidence: "مصدر واحد فقط" };
  return { rate: null, gap: null, sources: 0, confidence: "تعذّر الوصول — أدخل السعر يدويًا" };
}

export default async function handler(req, res){
  const out = {}, errors = [];
  await Promise.all([
    exrye("aden") .then(v => out.aden  = v, e => errors.push(e.message)),
    exrye("sanaa").then(v => out.sanaa = v, e => errors.push(e.message)),
    twodec()      .then(v => out.two   = v, e => errors.push(e.message))
  ]);

  /* buy is the side that matters: handing rial over for the client's
     dollars puts us where the changer buys, not where he sells */
  const city = (k) => ({
    USD: cross(out[k]?.USD?.buy,  out.two?.[k]?.USD?.buy),
    SAR: cross(out[k]?.SAR?.buy,  out.two?.[k]?.SAR?.buy),
    spread: out[k]?.USD ? { buy: out[k].USD.buy, sell: out[k].USD.sell } : null
  });

  const body = {
    aden:  city("aden"),
    sanaa: city("sanaa"),
    fetchedAt: new Date().toISOString(),
    upstreamStamp: out.two?.stamp ?? null,
    errors
  };

  /* the gap between the two cities is itself a sanity check: it has sat
     near 3x for a long while, so a wild reading means a parse went wrong */
  if(body.aden.USD.rate && body.sanaa.USD.rate){
    body.cityGap = +(body.aden.USD.rate / body.sanaa.USD.rate).toFixed(2);
    if(body.cityGap < 1.5 || body.cityGap > 6) errors.push("فجوة المدينتين غير معقولة — تحقّق من المصادر");
  }

  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(body.aden.USD.rate || body.sanaa.USD.rate ? 200 : 502).json(body);
}
