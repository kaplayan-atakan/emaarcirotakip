# BD EmaarJS — Proje Özeti ve Son Durum

## Projenin Amacı
- RESTO_16 (RESTO) ve DWH kaynaklarından günlük ve aylık satış verilerini toplayıp Emaar Monthly/Daily Sales API'larına iletmek.
- Hem otomatik (scheduler) hem de manuel (web UI) gönderim imkanı sağlamak.
- Gönderimler, manuel düzeltmeler ve API cevapları için ayrıntılı log tutmak (personelLog, aylikGonderimLog).
- Windows Service olarak çalışabilir biçimde stabilize etmek.

## Kapsam ve Bileşenler
- Node.js uygulaması (Express tabanlı web arayüzü + API entegrasyonu)
- DWH kaynağı: `DWH.dbo.FactKisiSayisiCiro` (günlük ham veriler)
- RESTO veritabanı: `basar.personelLog`, `basar.aylikGonderimLog` (loglama ve aylık kayıtlar)
- Scheduler'lar:
  - Günlük gönderim (dailyScheduler.js) — her gün 17:00'de önceki günün verisini gönderir (yeni öneri)
  - Aylık gönderim (monthly-operations.js) — ayın 2'sinde çalışır, manuel düzeltmeleri (personelLog) göz önüne alır
- API entegrasyonu: Emaar Daily ve Monthly Sales API (payload formatı ve tip eşlemeleri düzeltildi)
- Yardımcı scriptler: `setup-monthly-table.js`, `analyze-difference.js`, `analyze-sent-data.js`, `fix-personel-log.js`, `deep-analysis.js`

## Tamamlanan İşler
- Windows Service dönüşümü ve install/uninstall scriptleri eklendi.
- Aylık gönderim mantığı `monthly-operations.js` içinde uygulandı; manuel düzeltmeleri dikkate alıyor.
- `basar.aylikGonderimLog` tablosu eklendi ve indeksler oluşturuldu (SQL ve Node script).
- Web UI'da aylık sekmesi, preview ve manuel gönderim özellikleri eklendi.
- API payload tipi ve alan isimleri (string vs number, case) Emaar dokümantasyonuna göre düzeltildi.
- `analyze-difference.js` ve `analyze-sent-data.js` ile günlük/aylık tutarsızlık analizleri yapıldı.
- `fix-personel-log.js` ile personelLog okuma/yazma doğrulandı; veri modelindeki tarih/format durumları incelendi.

## Önemli Bulgular
- İlk iddianın aksine, DWH günlük toplamları ile aylık gönderim toplamları eşleşiyordu (çok küçük farklar: kuruş seviyesinde).
- Daha sonra, "gönderilen" günlük kayıtların toplamı ile aylık log toplamı arasında önemli bir fark bulundu. Bu farkın ana nedenleri:
  - Gönderilen günlük kayıtların kapsamı (ör. sadece belirli günlerin gönderilmiş olması)
  - Tarih formatlama/parsing hataları ve bazı `veri3` formatlarının `undefined` dönmesi
  - Bazı tarihler için duplicate (aynı gün birden fazla) gönderimler
- Ortaya çıkan toplam farklar analizle: günlük gönderimler toplamı 3,172,725.99₺ iken aylık log toplamı 2,981,186.51₺ — aradaki fark ~191,539.48₺. Bu, 20.000₺ mitinden farklı bir tespit.

## Mevcut Dosyalar / Önemli Scriptler
- `index.js` — Ana uygulama, mevcut scheduler çağrıları (aylık scheduler burada), servis entegrasyonu
- `dailyScheduler.js` — (önerildi / oluşturuldu) Her gün önceki günün verisini göndermek için kullanılacak
- `monthly-operations.js` — Aylık hesaplama, manuel düzeltme entegrasyonu, aylık API gönderimi
- `analyze-difference.js`, `analyze-sent-data.js`, `deep-analysis.js`, `fix-personel-log.js` — inceleme ve düzeltme scriptleri
- `setup-monthly-table.js` — veritabanı tablo kurulum scripti

## Çalıştırma / Yönetim Notları
- Node çalıştırma: `node index.js` (veya servis olarak çalıştırılan `emaarciroservice`)
- Analiz scriptleri: `node analyze-difference.js`, `node analyze-sent-data.js`, `node deep-analysis.js`
- Veritabanı bağlantı bilgileri dosyalarda (development/production ayrımı yok). Güvenlik gereği bu bilgilerin çevresel değişkenlere taşınması önerilir.

## Açık / Bekleyen İşler (Önceliklendirilmiş)
1. dailyScheduler.js dosyasını oluşturup `index.js` içindeki eski 3-günlük scheduler bloğunu kaldırmak (isteğiniz üzerine yapılacak). (Yüksek öncelik)
2. `veri3` tarih formatlarının normalize edilmesi; tüm personelLog girişlerinde standart `DD.MM.YYYY` veya ISO tarih kullanımı garanti altına alınmalı.
3. Duplicate gönderimler için otomatik kontrol/düzeltme — aynı gün için birden fazla başarılı kayıt varsa uyarı veya manuel review gereksinimi.
4. Konfigürasyon (DB user/pass, API anahtarları) environment variable veya secrets store'a taşınmalı.
5. Monitoring/alerting — scheduler hatalarında e-posta/Slack bildirimlerinin stabil çalıştığından emin olun.

## Öneriler
- Üretimde DB kimlik bilgilerini environment değişkenlerine taşıyın.
- `dailyScheduler`'ı yaratıp test edin; günlük gönderim yalnızca "önceki gün" verisini gönderecek şekilde ayarlansın.
- `personelLog.veri3` doğrulama katmanı ekleyin (geçersiz tarih gelirse görev loglasın ve atlasın).
- Aylık hesaplamada `personelLog`’daki manuel düzeltmelerin net etkisini otomatik raporla (aylık özet raporu).

## İletişim ve Son Not
- Hazır durumdaki analizler ve script çıktıları workspace içinde kaydedildi (`*.js` log/analysis scriptleri).
- İsterseniz şimdi `index.js` içinden 3-günlük scheduler bloğunu kaldırıp `dailyScheduler.js` oluşturup uygulamayı güncelleyeyim.

---
_Not: Bu dosya otomatik olarak oluşturuldu. Daha ayrıntılı teknik değişiklikler veya deploy adımları isterseniz hemen uygulayabilirim._
