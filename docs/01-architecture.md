# 01 – Mimari & Modüler Yapı

## Genel Bileşenler
| Bileşen | Açıklama |
|---------|----------|
| Express Sunucu (`index.js`) | HTTP UI + API endpoint’leri, scheduler tetikleyici, HTML render |
| `monthly-operations.js` | Aylık veri hesaplama, gönderim kontrolü, auto-fill fonksiyonları |
| `alerting.js` | Merkezi hata e-posta gönderimi, rate-limit ve dedup hash |
| `samples/` | Örnek email HTML şablonu |
| `daemon/` | Windows service wrapper (eski kurulum) |

## Veri Akışı (Günlük)
1. DWH’den dünkü kayıt sorgulanır.
2. personelLog üzerinde aynı gün için statuscode=201 var mı? → Varsa atla.
3. API (Emaar) → axios POST (daily payload).
4. Başarılı cevap → personelLog insert (statuscode=201) + başarı maili.
5. Hata → personelLog insert (statuscode!=201) + alerting.

## Veri Akışı (Aylık)
1. Beklenen gün listesi (1..N) oluşturulur.
2. personelLog’taki 201’ler üzerinden sum (ciro/kisi) + eksik gün listesi.
3. Eksik gün varsa gönderim iptal (manuel aylık send veya scheduler) – kullanıcıya uyarı.
4. Eksik yoksa aylık API payload tek seferde gönderilir.
5. Başarılı cevap aylık gönderim log tablosuna (basar.aylikGonderimLog) kaydedilir.

## Modüller Arası İlişkiler
- index.js → monthly-operations.setConfig() ile konfigürasyon enjeksiyonu
- monthly-operations → externalErrorNotifier (alerting) kullanarak hata maili
- alerting.js → nodemailer ile SMTP

## Kritik Kararlar
- Aylık hesap DWH yeniden tarama yerine LOG idempotency + sum: Daha hızlı ve ‘gerçek gönderilmiş’ veriye güven.
- Tarih formatı standardizasyonu: UI ve log için dd.MM.yyyy; API için iso (yyyy-MM-dd) dönüştürme.
- Numeric alanlar API’ye string (NetSalesAmount, NoofTransactions) gönderiliyor (tutarlılık).

## Next.js’e Etkisi
| Eski | Yeni (Next.js) Öneri |
|------|----------------------|
| Express route `/send` | `/api/daily/send` (Route Handler) |
| `/monthly-preview` | `/api/monthly/preview` |
| `/monthly-autofill-run` | `/api/monthly/autofill` |
| Inline HTML | `/app` veya `/pages` + komponentler |
| node-schedule | edge değil; Node runtime `cron` / dış scheduler (PM2, serverless cron) |

## UML (Basit)
```
User -> (Next.js UI) -> /api/daily/send -> Emaar API
Scheduler -> /api/daily/send (otomatik) -> Emaar API
Monthly UI -> /api/monthly/preview -> personelLog
Monthly Auto-Fill -> /api/monthly/autofill -> DWH + Emaar API
Alerting -> SMTP
```
