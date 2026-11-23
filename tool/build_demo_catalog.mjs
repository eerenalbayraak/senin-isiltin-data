// Demo katalog üretici
// -----------------------------------------------------------------------------
// seninisiltin.com'un herkese açık HTML sayfalarındaki gömülü sayfa verisinden
// (__NEXT_DATA__) gerçek ürünleri okuyup uygulamanın kendi veri formatına
// (assets/data/catalog.json) dönüştürür. ikas API erişimi gelene kadar
// uygulama bu dosyayla çalışır.
//
// Sitenin robots.txt kurallarına uyar: yalnızca izin verilen normal sayfaları
// (ana sayfa, kategori ve ürün sayfaları) okur; /_next/data/, /cart,
// /checkout, /account ve /admin adreslerine hiç istek atmaz.
//
// Kullanım:  node tool/build_demo_catalog.mjs
// -----------------------------------------------------------------------------
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://seninisiltin.com';
// Çıktı yolu: CATALOG_OUT ortam değişkeni (GitHub Actions) ya da uygulamanın assets klasörü.
const OUT = process.env.CATALOG_OUT ||
  join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'data', 'catalog.json');
// Bundan azı çıkarsa site değişmiş ya da erişim engellenmiş demektir; yayınlama.
const MIN_PRODUCTS = 60;
const MIN_CATEGORIES = 8;
const DELAY_MS = 600; // siteyi yormamak için istekler arası bekleme
const HEADERS = { 'User-Agent': 'SeninIsiltinApp-CatalogBuilder/1.0', Accept: 'text/html' };
const MERCHANT_IMAGE_BASE = 'https://cdn.myikas.com/images/02ca5243-1011-4238-ac42-e035e82723b4';

// Uygulamadaki menü yapısı (sitenin menüsüyle aynı sırada).
const MENU = [
  { slug: 'yeni-gelenler', name: 'Yeni Gelenler' },
  { slug: 'ust-giyim', name: 'Üst Giyim' },
  { slug: 'alt-giyim', name: 'Alt Giyim' },
  { slug: 'dis-giyim', name: 'Dış Giyim' },
  { slug: 'elbise', name: 'Elbise' },
  { slug: 'aksesuar', name: 'Aksesuar', children: [
    { slug: 'taki-koleksiyonu', name: 'Takı' },
    { slug: 'gozluk', name: 'Gözlük' },
    { slug: 'sapka', name: 'Şapka' },
    { slug: 'saat', name: 'Saat' },
    { slug: 'canta', name: 'Çanta' },
    { slug: 'fular-sal', name: 'Fular & Şal' },
  ] },
  { slug: 'beachwear', name: 'Beachwear' },
  { slug: 'premium-selection', name: 'Premium Selection' },
  { slug: 'son-sans', name: 'Son Şans' },
  { slug: 'indirim', name: 'İndirim' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();

// robots.txt'de "Disallow" olan yollar; bunlara asla istek atılmaz.
const DISALLOWED = ['/_next/data/', '/cart', '/checkout', '/account', '/admin'];

/** Normal bir site sayfasını açar ve içine gömülü sayfa verisini (pageProps) döndürür. */
async function getPageProps(path) {
  if (DISALLOWED.some((d) => path === d || path.startsWith(d.endsWith('/') ? d : d + '/') || path.startsWith(d + '?'))) {
    throw new Error(`robots.txt izin vermiyor: ${path}`);
  }
  const url = ORIGIN + path;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`sayfa verisi bulunamadı: ${url}`);
  const pp = JSON.parse(m[1])?.props?.pageProps;
  if (!pp) throw new Error(`pageProps yok: ${url}`);
  return pp;
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

  const variants = (p.variants ?? [])
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

  return {
    id: p.id,
    slug: p.metaData?.slug,
    name: clean(p.name),
    descriptionHtml: p.description ?? '',
    categorySlugs: [...new Set((p.categories ?? []).map((c) => c.metaData?.slug ?? c.slug).filter(Boolean))],
    variantTypes,
    variants,
  };
}

function themeImage(v) {
  let id = typeof v === 'string' ? v : v?.id;
  if (!id) return null;
  if (!id.startsWith('theme-images/')) id = `theme-images/${id}`;
  return `https://cdn.myikas.com/images/${id}/image_{size}.webp`;
}

function linkToSlug(link) {
  const raw = link?.value ?? link;
  const href = typeof raw === 'string' ? raw : raw?.href ?? raw?.url ?? null;
  if (typeof href !== 'string') return null;
  return href.replace(ORIGIN, '').replace(/^\//, '').split('?')[0] || null;
}

const textOf = (x) => clean(typeof x === 'string' ? x : x?.value);

async function main() {
  console.log('Kaynak:', ORIGIN, '(HTML sayfaları, robots.txt uyumlu)');

  const products = new Map(); // id -> ürün
  const upsert = (raw, extraSlug) => {
    const m = mapProduct(raw);
    const prev = products.get(m.id);
    if (prev) m.categorySlugs = [...new Set([...prev.categorySlugs, ...m.categorySlugs])];
    if (extraSlug && !m.categorySlugs.includes(extraSlug)) m.categorySlugs.push(extraSlug);
    products.set(m.id, m);
    return m.id;
  };

  // --- Ana sayfa: slider, kategori görselleri, vitrin listeleri ---
  const home = await getPageProps('/');
  const banners = [];
  const categoryTiles = [];
  const homeSections = [];
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
  for (const list of findProductLists(home.propValues)) {
    homeSections.push({ title: list.title || 'Yeni Sezon Yayında!', productIds: list.products.map((p) => upsert(p)) });
  }

  // --- Kategoriler ---
  const flat = MENU.flatMap((c) => [c, ...(c.children ?? []).map((x) => ({ ...x, parentSlug: c.slug }))]);
  const rank = new Map();
  for (const cat of flat) {
    await sleep(DELAY_MS);
    try {
      const pp = await getPageProps(`/${cat.slug}`);
      const lists = findProductLists(pp.propValues);
      const ids = lists.flatMap((l) => l.products.map((p) => upsert(p, cat.slug)));
      rank.set(cat.slug, [...new Set(ids)]);
      console.log(`  ${cat.slug}: ${ids.length} ürün (sitede toplam ${lists[0]?.total ?? '?'})`);
    } catch (e) {
      console.warn(`  ${cat.slug}: atlandı (${e.message})`);
    }
  }

  // --- Ürün detayları: liste verisinde açıklama ve görsellerin tamamı yok ---
  let n = 0;
  for (const [id, prev] of products) {
    await sleep(DELAY_MS); // HTML sayfaları daha ağır; siteyi yormamak için tam bekleme
    try {
      const pp = await getPageProps(`/${prev.slug}`);
      if (pp.pageType !== 'PRODUCT' || !pp.pageSpecificData?.variants) throw new Error('ürün sayfası değil');
      const full = mapProduct(pp.pageSpecificData);
      full.categorySlugs = [...new Set([...prev.categorySlugs, ...full.categorySlugs])];
      products.set(id, full);
    } catch (e) {
      console.warn(`  detay alınamadı: ${prev.slug} (${e.message})`);
    }
    if (++n % 25 === 0) console.log(`  detay: ${n}/${products.size}`);
  }

  const norm = (s) => s.toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  const categories = flat.map((c, i) => {
    const tile = categoryTiles.find((x) => x.targetSlug === c.slug || (x.title && norm(x.title) === c.slug));
    return {
      slug: c.slug,
      name: c.name,
      parentSlug: c.parentSlug ?? null,
      order: i,
      imageUrl: tile?.imageUrl ?? null,
      productIds: rank.get(c.slug) ?? [],
    };
  });

  // Varyantı ya da görseli olmayan ürünleri ayıkla
  const all = [...products.values()].filter((p) => p.slug && p.variants.length && p.variants.some((v) => v.images.length));
  const valid = new Set(all.map((p) => p.id));
  for (const c of categories) c.productIds = c.productIds.filter((id) => valid.has(id));
  for (const s of homeSections) s.productIds = s.productIds.filter((id) => valid.has(id));

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
    homeSections: homeSections.filter((s) => s.productIds.length),
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
  console.log(`\nTamam: ${all.length} ürün, ${categories.length} kategori, ${catalog.banners.length} banner, ${catalog.categoryTiles.length} kategori görseli`);
}

main().catch((e) => { console.error(e); process.exit(1); });
