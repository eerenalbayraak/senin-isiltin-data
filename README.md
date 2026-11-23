# Senin Işıltın – uygulama verisi

Senin Işıltın mobil uygulamasının internetten okuduğu herkese açık veri dosyaları.
Kod burada değil; uygulamanın kendisi gizli depodadır.

| Dosya | Ne işe yarar |
|---|---|
| `catalog.json` | Ürünler, kategoriler, ana sayfa bannerları ve kampanyalar. Günde üç kez (08:00, 13:00, 19:00) seninisiltin.com'dan otomatik yenilenir. |
| `update.json` | Uygulamanın zorunlu / isteğe bağlı güncelleme kuralı. Elle düzenlenir. |

## Otomatik yenileme

`.github/workflows/catalog.yml` görevi `tool/build_demo_catalog.mjs` betiğini çalıştırır.
Betik yalnızca robots.txt'nin izin verdiği sayfaları okur ve istekler arasında bekler.
Sonuç eksik görünürse (çok az ürün, banner yok) dosyayı yayınlamaz ve görev hata verir;
uygulama son sağlam katalogla çalışmaya devam eder.

Hemen yenilemek için: GitHub → Actions → "Katalog yenile" → **Run workflow**.

Betiğin asıl kopyası uygulama deposundadır; orada değişirse buraya da kopyalanmalıdır.

## Yeni sürüm yayınlarken (update.json)

Mağaza onayı geldikten **sonra** `latestVersion` yeni sürüm yapılır. Eski sürümleri
kullanılamaz yapmak için `minVersion` de yükseltilir.
