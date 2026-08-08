/* Live Algerian dinar rates from the parallel market (السكوار).

   The global feeds carry the Bank of Algeria's official rate, near 133 to
   the dollar. Nobody sending money home converts at it: the square trades
   near 240, some 80% away, and that is the rate the beneficiary actually
   receives at. Quoting the official number would understate a $15,000
   transfer by roughly 1.5 million dinars.

   Two sources are read and crossed, the same way /api/yer works, because a
   parallel-market number with nothing to check it against is worth very
   little — these pages go stale, or offline, without ever saying so.

   Sides matter here. Both sources quote the square from the customer's
   point of view: you buy foreign currency at the higher figure and sell it
   at the lower. Turning dollars into dinars for a beneficiary puts us on
   the selling side, so `sell` is the rate that is actually realised, and
   it is the one the desk should price from. Promising the higher number
   would be promising dinars we cannot buy. */

const strip = s => s.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
const txt   = s => strip(s).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
const n     = s => parseFloat(String(s).replace(/,/g, ""));

async function get(url){
  const r = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; hawala-desk/1.0)" },
    signal: AbortSignal.timeout(6000)
  });
  if(!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.text();
}

/* دينار بلس — both sides of the square plus the official rate, stamped in
   Algiers local time.

   Its front page teases only four currencies at a time out of a longer
   list, rotating which ones on every request; the dollar turns up in
   roughly a third of them. The figures themselves are steady, so it is the
   sampling that has to be worked around, not the data. A handful of
   requests go out together and the first one carrying the dollar wins.
   Four tries left roughly one call in seven with no dollar at all; six
   brings that under one in twenty, and the edge cache means a handful of
   requests every fifteen minutes rather than per visitor. */
const DP_TRIES = 6;

function readDinarplus(body){
  const t = txt(body);
  const grab = (label, code) => {
    const m = t.match(new RegExp(label + "\\s*" + code + "\\s*([\\d.,]+)\\s+([\\d.,]+)\\s+([\\d.,]+)"));
    return m ? { sell: n(m[1]), buy: n(m[2]), official: n(m[3]) } : null;
  };
  const USD = grab("الدولار", "USD");
  if(!USD) return null;
  return {
    USD,
    EUR: grab("اليورو", "EUR"),
    stamp: (t.match(/آخر تحديث\s*([^A-Z]{0,40}?)(?=[A-Z]{3}|$)/) || [,""])[1].trim()
  };
}

async function dinarplus(){
  const attempts = Array.from({length: DP_TRIES}, () =>
    get("https://www.dinarplus.com/").then(readDinarplus, () => null));
  for(const got of await Promise.all(attempts)){
    if(got) return got;
  }
  throw new Error("dinarplus: لم يظهر الدولار في هذه المحاولات");
}

/* blackmarketlive — one figure per currency, the square's buying side,
   in a plain table with the Algiers date in the page text */
async function bml(){
  const html = await get("https://en.blackmarketlive.org/dzd/");
  const rows = strip(html).match(/<tr[\s\S]*?<\/tr>/g) || [];
  const cells = r => [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
  const find = re => {
    const hit = rows.map(cells).find(c => c.length >= 2 && re.test(c[0]));
    return hit ? n(hit[1]) : null;
  };
  const USD = find(/^US Dollar$/i);
  if(!USD) throw new Error("bml: تغيّرت بنية الجدول");
  const stamp = (txt(html).match(/Today\s*\(\s*([^)]+?)\s*\)/) || [,""])[1];
  return { USD, EUR: find(/^Euro$/i), stamp };
}

function cross(a, b, label){
  const vals = [a, b].filter(v => typeof v === "number" && v > 0);
  if(vals.length === 2){
    const gap = Math.abs(vals[0] / vals[1] - 1) * 100;
    return { rate:(vals[0] + vals[1]) / 2, gap:+gap.toFixed(2), sources:2,
             confidence: gap < 2 ? "مؤكَّد" : "المصادر متباعدة — راجع صرّافك", label };
  }
  if(vals.length === 1) return { rate:vals[0], gap:null, sources:1, confidence:"مصدر واحد فقط", label };
  return { rate:null, gap:null, sources:0, confidence:"تعذّر الوصول — أدخل السعر يدويًا", label };
}

export default async function handler(req, res){
  const out = {}, errors = [];
  await Promise.all([
    dinarplus().then(v => out.dp = v, e => errors.push(e.message)),
    bml()      .then(v => out.bm = v, e => errors.push(e.message))
  ]);

  /* the two sources are only directly comparable on the buying side —
     dinarplus is the only one that publishes the selling side at all */
  const buy  = cross(out.dp?.USD?.buy, out.bm?.USD, "شراء");
  const sell = cross(out.dp?.USD?.sell, null, "بيع");

  const body = {
    usd: {
      sell,                       // ← the rate to price from
      buy,
      official: out.dp?.USD?.official ?? null,
      spread: (out.dp?.USD) ? +(out.dp.USD.buy - out.dp.USD.sell).toFixed(2) : null
    },
    eur: {
      sell: out.dp?.EUR?.sell ?? null,
      buy:  cross(out.dp?.EUR?.buy, out.bm?.EUR, "شراء")
    },
    fetchedAt: new Date().toISOString(),
    stamps: { dinarplus: out.dp?.stamp ?? null, blackmarketlive: out.bm?.stamp ?? null },
    errors
  };

  /* the parallel premium has sat near 1.8x for a long while; a reading far
     off that means a parse drifted onto the official column by mistake */
  if(body.usd.sell.rate && body.usd.official){
    body.premium = +(body.usd.sell.rate / body.usd.official).toFixed(2);
    if(body.premium < 1.2 || body.premium > 3) errors.push("الفارق عن السعر الرسمي غير معقول — تحقّق من المصادر");
  }

  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(body.usd.sell.rate || body.usd.buy.rate ? 200 : 502).json(body);
}
