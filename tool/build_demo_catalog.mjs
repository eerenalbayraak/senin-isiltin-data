// Demo katalog üretici
// -----------------------------------------------------------------------------
// seninisiltin.com'un herkese açık HTML sayfalarındaki gömülü sayfa verisinden
// (__NEXT_DATA__) ürünleri, menüyü ve ana sayfa kampanyalarını okuyup
// uygulamanın veri formatına (catalog.json) dönüştürür. ikas API erişimi
// gelene kadar uygulama bu dosyayla çalışır.
//
// Sitenin robots.txt kurallarına uyar: yalnızca izin verilen normal sayfaları
// (ana sayfa, kategori, ürün sayfaları ve sitemap) okur; /_next/data/, /cart,
// /checkout, /account ve /admin adreslerine hiç istek atmaz.
//
// Siteyi yormamak için artımlı çalışır:
//   - Tüm ürünler sitemap'ten (products.xml) bulunur; her ürünün "lastmod" zamanı var.
//   - Bir çalıştırmada en fazla DETAIL_BUDGET ürün sayfası açılır: önce yeni ve
//     değişen ürünler, sonra en uzun süredir bakılmamış olanlar (stok tazeliği).
//   - Diğer ürünler bir önceki katalogdan aynen alınır.
//   - Menüdeki her kategorinin ilk 20 ürününün fiyat ve stoğu her çalıştırmada tazelenir.
//
// Kullanım:  node tool/build_demo_catalog.mjs
// Ortam değişkenleri (hepsi isteğe bağlı):
//   CATALOG_OUT    çıktı dosyası            (varsayılan: assets/data/catalog.json)
//   CATALOG_PREV   önceki katalog           (varsayılan: CATALOG_OUT)
//   CATALOG_STATE  tarama durumu dosyası    (varsayılan: build/catalog_state.json)
//   DETAIL_BUDGET  çalıştırma başına en fazla açılacak ürün sayfası (varsayılan: 400)
// -----------------------------------------------------------------------------
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://seninisiltin.com';
const OUT = process.env.CATALOG_OUT || join(ROOT, 'assets', 'data', 'catalog.json');
const PREV = process.env.CATALOG_PREV || OUT;
const STATE = process.env.CATALOG_STATE || join(ROOT, 'build', 'catalog_state.json');
const DETAIL_BUDGET = Number(process.env.DETAIL_BUDGET ?? 400);
// Bundan azı çıkarsa site değişmiş ya da erişim engellenmiş demektir; yayınlama.
const MIN_PRODUCTS = 60;
const MIN_CATEGORIES = 5;
const DELAY_MS = 700; // siteyi yormamak için istekler arası bekleme
const HEADERS = { 'User-Agent': 'SeninIsiltinApp-CatalogBuilder/1.0', Accept: 'text/html' };
const MERCHANT_IMAGE_BASE = 'https://cdn.myikas.com/images/02ca5243-1011-4238-ac42-e035e82723b4';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();
const textOf = (x) => clean(typeof x === 'string' ? x : x?.value);

// robots.txt'de "Disallow" olan yollar; bunlara asla istek atılmaz.
const DISALLOWED = ['/_next/data/', '/cart', '/checkout', '/account', '/admin'];

function assertAllowed(path) {
  if (DISALLOWED.some((d) => path === d || path.startsWith(d.endsWith('/') ? d : d + '/') || path.startsWith(d + '?'))) {
    throw new Error(`robots.txt izin vermiyor: ${path}`);
  }
}

async function getText(path) {
  assertAllowed(path);
  const url = ORIGIN + path;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const err = new Error(`${res.status} ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/** Normal bir site sayfasını açar ve içine gömülü sayfa verisini (pageProps) döndürür. */
async function getPageProps(path) {
  const html = await getText(path);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`sayfa verisi bulunamadı: ${path}`);
  const pp = JSON.parse(m[1])?.props?.pageProps;
  if (!pp) throw new Error(`pageProps yok: ${path}`);
  return pp;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** propValues içindeki ürün listelerini (başlıklarıyla) bulur. */
function findProductLists(propValues) {
  const lists = [];
  for (const comp of propValues ?? []) {
    const pv = comp?.propValues ?? {};
    const pl = pv.productsList;
    if (pl && Array.isArray(pl.data) && pl.data.length && pl.data[0].variants) {
      const title = typeof pv.title === 'string' ? pv.title : pv.title?.value;
      lists.push({ title: clean(title), products: pl.data, total: pl.count });
    }
  }
  return lists;
}

function productImage(img) {
  // ikas ürün görseli: https://cdn.myikas.com/images/{merchant}/{imageId}/{size}/{fileName}.webp
  if (!img?.imageId || !img?.fileName) return null;
  return `${MERCHANT_IMAGE_BASE}/${img.imageId}/{size}/${img.fileName}.webp`;
}

/** Ürünün kendi kategorileri ve onların üst kategorileri (Kolye → Takı → Aksesuar). */
function categorySlugsOf(p) {
  const slugs = new Set();
  for (const c of p.categories ?? []) {
    const s = c.metaData?.slug ?? c.slug;
    if (s) slugs.add(s);
    for (const parent of c.path ?? []) if (parent.slug) slugs.add(parent.slug);
  }
  return [...slugs];
}

function mapVariants(p) {
  return (p.variants ?? [])
    .filter((v) => !v.deleted && v.isActive !== false)
    .map((v) => {
      const price = (v.prices ?? [])[0] ?? {};
      const stock = typeof v.stock === 'number' ? v.stock
        : (v.stocks ?? []).reduce((s, x) => s + (x.stockCount ?? 0), 0);
      return {
        id: v.id,
        sku: v.sku ?? null,
        valueIds: (v.variantValues ?? []).map((x) => x.id),
        price: price.sellPrice ?? 0,
        discountPrice: price.discountPrice ?? null,
        stock,
        sellIfOutOfStock: !!v.sellIfOutOfStock,
        images: [...(v.images ?? [])]
          .filter((i) => !i.isVideo)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map(productImage)
          .filter(Boolean),
      };
    });
}

function mapProduct(p) {
  const variantTypes = [...(p.variantTypes ?? [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((vt) => ({
      id: vt.variantType.id,
      name: clean(vt.variantType.name),
      isColor: vt.variantType.selectionType === 'COLOR',
      values: vt.variantType.values
        .filter((v) => (vt.variantValueIds ?? []).includes(v.id))
        .map((v) => ({ id: v.id, name: clean(v.name), colorCode: v.colorCode || null })),
    }));

  return {
    id: p.id,
    slug: p.metaData?.slug,
    name: clean(p.name),
    descriptionHtml: p.description ?? '',
    categorySlugs: categorySlugsOf(p),
    variantTypes,
    variants: mapVariants(p),
  };
}

/** Liste verisindeki güncel fiyat ve stoğu, daha önce okunmuş tam ürüne işler. */
function refreshPricesFromList(product, raw) {
  const fresh = new Map(mapVariants(raw).map((v) => [v.id, v]));
  return {
    ...product,
    variants: product.variants.map((v) => {
      const f = fresh.get(v.id);
      return f ? { ...v, price: f.price, discountPrice: f.discountPrice, stock: f.stock, sellIfOutOfStock: f.sellIfOutOfStock } : v;
    }),
  };
}

function themeImage(v) {
  let id = typeof v === 'string' ? v : v?.id;
  if (!id) return null;
  if (!id.startsWith('theme-images/')) id = `theme-images/${id}`;
  return `https://cdn.myikas.com/images/${id}/image_{size}.webp`;
}

function hrefToSlug(href) {
  if (typeof href !== 'string') return null;
  const path = href.replace(ORIGIN, '').split('?')[0];
  if (!path.startsWith('/') || path.startsWith('/pages/') || path.startsWith('/account')) return null;
  return path.replace(/^\//, '').replace(/\/$/, '') || null;
}

function linkToSlug(link) {
  const raw = link?.value ?? link;
  const href = typeof raw === 'string' ? raw : raw?.href ?? raw?.url ?? null;
  return hrefToSlug(href);
}

/** Karşılaştırma için sadeleştirme: "PREMIUM Selection" ve "Premium Selection" -> "premium-selection". */
const norm = (s) => clean(s).toLocaleLowerCase('tr')
  .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "ÜST GİYİM" -> "Üst Giyim", "THE NEW!" -> "The New!" (Türkçe kurallarla). */
function titleCaseTr(s) {
  return clean(s)
    .toLocaleLowerCase('tr')
    .split(' ')
    .map((w) => (w ? w[0].toLocaleUpperCase('tr') + w.slice(1) : w))
    .join(' ');
}

/** Sitenin menüsü: üst menü (alt kategorileriyle) + alt bilgideki "Kategoriler" listesinde olup üstte olmayanlar. */
function readMenu(propValues) {
  let header = null;
  let footer = [];
  for (const comp of propValues ?? []) {
    const pv = comp?.propValues ?? {};
    if (!header && Array.isArray(pv.headerLinks)) header = pv.headerLinks;
    for (const group of pv.links?.value ?? []) {
      if (textOf(group.value?.title).toLocaleLowerCase('tr') === 'kategoriler') footer = group.value?.subLinks?.value ?? [];
    }
  }
  const menu = [];
  const seen = new Set();
  const add = (link, parentSlug) => {
    const slug = hrefToSlug(link.href);
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const label = clean(link.label);
    const isUpper = label === label.toLocaleUpperCase('tr');
    menu.push({ slug, name: isUpper ? titleCaseTr(label) : label, parentSlug });
    for (const sub of link.subLinks ?? []) add(sub, slug);
  };
  for (const link of header ?? []) add(link, null);
  for (const link of footer) add(link, null);
  return menu;
}

/** products.xml: [{slug, lastmod}] */
async function readProductSitemap() {
  const xml = await getText('/products.xml');
  const entries = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
    const lastmod = m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? '';
    const slug = hrefToSlug(loc);
    if (slug) entries.push({ slug, lastmod });
  }
  return entries;
}

async function main() {
  const started = Date.now();
  console.log('Kaynak:', ORIGIN, '(HTML sayfaları ve sitemap, robots.txt uyumlu)');

  const prevCatalog = await readJson(PREV, null);
  const prevBySlug = new Map((prevCatalog?.products ?? []).map((p) => [p.slug, p]));
  // Durum: slug -> { lastmod, fetchedAt, cats } (cats: ürün sayfasındaki kategoriler)
  const state = await readJson(STATE, {});
  console.log(`Önceki katalog: ${prevBySlug.size} ürün, durum kaydı: ${Object.keys(state).length} ürün`);

  // --- Ana sayfa: menü, slider, kategori görselleri, duyurular, vitrin ---
  const home = await getPageProps('/');
  const menu = readMenu(home.propValues);
  if (!menu.length) throw new Error('Site menüsü okunamadı');
  console.log('Menü:', menu.map((c) => (c.parentSlug ? `  ${c.name}` : c.name)).join(' | '));

  const banners = [];
  const categoryTiles = [];
  let announcements = [];
  let freeShippingAmount = null;
  for (const comp of home.propValues ?? []) {
    const pv = comp.propValues ?? {};
    for (const s of pv.sliders?.value ?? []) {
      const v = s.value ?? {};
      banners.push({
        imageUrl: themeImage(v.image?.value),
        mobileImageUrl: themeImage(v.mobileImage?.value) ?? themeImage(v.image?.value),
        title: textOf(v.title),
        subtitle: textOf(v.secondTitle) || textOf(v.description),
        buttonText: textOf(v.buttonText),
        targetSlug: linkToSlug(v.link ?? v.buttonLink),
      });
    }
    for (const c of pv.categoryImageItems?.value ?? []) {
      const v = c.value ?? {};
      categoryTiles.push({
        imageUrl: themeImage(v.image?.value),
        title: textOf(v.title) || textOf(v.text),
        targetSlug: linkToSlug(v.link ?? v.buttonLink),
      });
    }
    if (Array.isArray(pv.announcements?.value)) {
      announcements = pv.announcements.value
        .map((a) => textOf(a.value?.text) || textOf(a.value?.title))
        .filter(Boolean);
    }
    if (pv.freeShippingAmount?.value) freeShippingAmount = Number(pv.freeShippingAmount.value) || null;
  }

  // Listelerde görülen ürünlerin ham verisi (güncel fiyat/stok) ve kategori üyelikleri
  const listRaw = new Map(); // slug -> ham ürün
  const listedIn = new Map(); // slug -> Set(kategori slug)
  const remember = (raw, catSlug) => {
    const slug = raw.metaData?.slug;
    if (!slug) return null;
    listRaw.set(slug, raw);
    if (catSlug) {
      if (!listedIn.has(slug)) listedIn.set(slug, new Set());
      listedIn.get(slug).add(catSlug);
    }
    return slug;
  };

  const homeSections = findProductLists(home.propValues).map((list) => ({
    title: list.title || 'Yeni Sezon Yayında!',
    slugs: list.products.map((p) => remember(p)).filter(Boolean),
  }));

  // --- Menüdeki kategoriler: sitedeki ilk sıralama (ilk 20 ürün) ---
  const rank = new Map(); // kategori slug -> ürün slug sırası
  for (const cat of menu) {
    await sleep(DELAY_MS);
    try {
      const pp = await getPageProps(`/${cat.slug}`);
      const lists = findProductLists(pp.propValues);
      const slugs = lists.flatMap((l) => l.products.map((p) => remember(p, cat.slug))).filter(Boolean);
      rank.set(cat.slug, [...new Set(slugs)]);
      // Menü yazısı büyük harfse ve kategorinin asıl adıyla aynıysa asıl adı kullan
      // ("PREMIUM SELECTION" -> "Premium Selection"; Türkçe kuralla "Premıum" olmasın).
      const pageName = clean(pp.pageSpecificData?.name);
      const mixedCase = pageName !== pageName.toLocaleUpperCase('tr');
      if (pageName && mixedCase && norm(pageName) === norm(cat.name)) cat.name = pageName;
      const auto = pp.pageSpecificData?.isAutomated ? ', otomatik kategori' : '';
      console.log(`  ${cat.slug}: ilk ${slugs.length} ürün (sitede toplam ${lists[0]?.total ?? '?'}${auto})`);
    } catch (e) {
      console.warn(`  ${cat.slug}: atlandı (${e.message})`);
    }
  }

  // --- Tüm ürünler: sitemap ---
  await sleep(DELAY_MS);
  const sitemap = await readProductSitemap();
  if (sitemap.length < MIN_PRODUCTS) throw new Error(`Sitemap'te çok az ürün var (${sitemap.length})`);
  const lastmodOf = new Map(sitemap.map((e) => [e.slug, e.lastmod]));
  console.log(`Sitemap: ${sitemap.length} ürün`);

  // Açılacak ürün sayfaları: önce yeni/değişen (listelerde görünenler başta), sonra en eski bakılanlar.
  const isStale = (e) => !prevBySlug.has(e.slug) || !state[e.slug] || state[e.slug].lastmod !== e.lastmod;
  const changed = sitemap.filter(isStale)
    .sort((a, b) => (listRaw.has(b.slug) ? 1 : 0) - (listRaw.has(a.slug) ? 1 : 0) || b.lastmod.localeCompare(a.lastmod));
  const rolling = sitemap.filter((e) => !isStale(e))
    .sort((a, b) => (state[a.slug]?.fetchedAt ?? '').localeCompare(state[b.slug]?.fetchedAt ?? ''));
  const queue = [...changed, ...rolling].slice(0, Math.max(0, DETAIL_BUDGET));
  console.log(`Ürün sayfası: ${changed.length} yeni/değişen, bu çalıştırmada ${queue.length} sayfa açılacak (sınır ${DETAIL_BUDGET})`);

  const fetched = new Map(); // slug -> tam ürün
  const gone = new Set();
  let n = 0;
  for (const e of queue) {
    await sleep(DELAY_MS);
    try {
      const pp = await getPageProps(`/${e.slug}`);
      if (pp.pageType !== 'PRODUCT' || !pp.pageSpecificData?.variants) throw new Error('ürün sayfası değil');
      const full = mapProduct(pp.pageSpecificData);
      fetched.set(e.slug, full);
      state[e.slug] = { lastmod: e.lastmod, fetchedAt: new Date().toISOString(), cats: full.categorySlugs };
    } catch (err) {
      if (err.status === 404 || err.status === 410) gone.add(e.slug);
      else console.warn(`  detay alınamadı: ${e.slug} (${err.message})`);
    }
    if (++n % 50 === 0) console.log(`  detay: ${n}/${queue.length}`);
  }

  // --- Son ürün listesi: sitemap sırasıyla; okunmayanlar önceki katalogdan ---
  const products = [];
  const productSlugs = new Set([...sitemap.map((e) => e.slug), ...listRaw.keys()]);
  for (const slug of productSlugs) {
    if (gone.has(slug)) continue;
    let p = fetched.get(slug) ?? prevBySlug.get(slug) ?? null;
    if (!p && listRaw.has(slug)) p = mapProduct(listRaw.get(slug)); // açıklaması sonraki çalıştırmada gelir
    if (!p) continue; // henüz hiç okunmamış; sırası gelince eklenecek
    if (!fetched.has(slug) && listRaw.has(slug)) p = refreshPricesFromList(p, listRaw.get(slug));
    const cats = new Set([...(state[slug]?.cats ?? p.categorySlugs ?? []), ...(listedIn.get(slug) ?? [])]);
    products.push({ ...p, categorySlugs: [...cats] });
  }
  // Varyantı ya da görseli olmayanları ayıkla; yeniden eskiye sırala (kategori sonu sıralaması için).
  const all = products
    .filter((p) => p.slug && p.variants.length && p.variants.some((v) => v.images.length))
    .sort((a, b) => (lastmodOf.get(b.slug) ?? '').localeCompare(lastmodOf.get(a.slug) ?? ''));
  const idBySlug = new Map(all.map((p) => [p.slug, p.id]));

  // Sitemap'ten çıkmış ürünlerin durum kaydını temizle.
  for (const slug of Object.keys(state)) if (!lastmodOf.has(slug)) delete state[slug];

  const categories = menu.map((c, i) => {
    const tile = categoryTiles.find((x) => x.targetSlug === c.slug || (x.title && norm(x.title) === c.slug));
    return {
      slug: c.slug,
      name: c.name,
      parentSlug: c.parentSlug,
      order: i,
      imageUrl: tile?.imageUrl ?? null,
      productIds: (rank.get(c.slug) ?? []).map((s) => idBySlug.get(s)).filter(Boolean),
    };
  });

  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    note: 'Demo veri: seninisiltin.com herkese açık sayfalarından üretildi. ikas API bağlanınca kullanılmayacak.',
    store: {
      name: 'Senin Işıltın',
      currency: 'TRY',
      freeShippingThreshold: freeShippingAmount ?? 3500,
      shippingFee: 120,
      deliveryText: 'Teslimat süresi 1-7 iş günüdür.',
      announcements: announcements.length ? announcements : ['3500 TL ÜZERİNE ÜCRETSİZ GÖNDERİM'],
      whatsapp: '905015170866',
      instagram: 'seninisiltin',
      webOrigin: ORIGIN,
    },
    banners: banners.filter((b) => b.imageUrl),
    categoryTiles: categoryTiles.filter((c) => c.imageUrl),
    homeSections: homeSections
      .map((s) => ({ title: s.title, productIds: s.slugs.map((x) => idBySlug.get(x)).filter(Boolean) }))
      .filter((s) => s.productIds.length),
    categories,
    products: all,
  };

  const problems = [];
  if (all.length < MIN_PRODUCTS) problems.push(`ürün sayısı çok az (${all.length})`);
  if (categories.length < MIN_CATEGORIES) problems.push(`kategori sayısı çok az (${categories.length})`);
  if (!catalog.banners.length) problems.push('ana sayfa bannerı yok');
  if (problems.length) {
    throw new Error(`Katalog yazılmadı, mevcut dosya korunuyor: ${problems.join(', ')}`);
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(catalog), 'utf8');
  await mkdir(dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(state), 'utf8');

  const covered = sitemap.filter((e) => state[e.slug]).length;
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\nTamam (${mins} dk): ${all.length} ürün, ${categories.length} kategori, ${catalog.banners.length} banner, ${catalog.categoryTiles.length} kategori görseli`);
  console.log(`Tarama kapsamı: ${covered}/${sitemap.length} ürün sayfası okundu` +
    (covered < sitemap.length ? ' (kalanlar sonraki çalıştırmalarda)' : ''));
}

main().catch((e) => { console.error(e); process.exit(1); });
