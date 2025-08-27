# 11 – Next.js Geçiş Rehberi

## Hedefler
- Modüler API Route'lar
- Server Actions (uygun yerlerde)
- Ortak DB erişim katmanı
- UI: React component + SSR/ISR

## Aşamalı Strateji
1. Read-Only Fazı: Mevcut DB'den veriyi göster (risk düşük)
2. Kritik POST endpoint taşıma (/send, /monthly-autofill-run)
3. Scheduler dışarıda (Node worker) → API sadece tetikleyici
4. Auto-Fill & raporlama entegre edilince legacy kapatma

## Route Haritası
| Legacy | Next.js API |
|--------|-------------|
| GET / | pages/index (ya da app/page) |
| GET /daily-log-details | /api/daily/log-details |
| POST /send | /api/daily/send |
| POST /monthly-autofill-run | /api/monthly/autofill |
| GET /monthly-preview | /api/monthly/preview |

## DB Katmanı
`/lib/db/mssql.ts`
```ts
import sql from 'mssql';
let poolPromise;
export function getPool(){
  if(!poolPromise){
    poolPromise = sql.connect(process.env.MSSQL_CONN_STR);
  }
  return poolPromise;
}
```

## Status Hesaplama Helper
`/lib/status/daily.ts`
```ts
export function isDaySuccess(rows){
  return rows.some(r=>r.statuscode===201);
}
```

## Scheduler Seçenekleri
- Ayrı Node process (pm2) + cron
- Veya bulut tabanlı (Azure WebJob / AWS EventBridge) → API'ye webhook POST

## Ortak Kodun Taşınması
- monthly-operations.js → lib/monthly/
- alerting.js → lib/alerting/
- date utils → lib/dates/

## Çevresel Değişkenler (.env.local örnek)
```
MSSQL_CONN_STR=Server=...;Database=...;User Id=...;Password=...;Encrypt=true
ALERT_EMAIL_TO=ops@example.com
SMTP_HOST=smtp.office365.com
SMTP_USER=...
SMTP_PASS=...
```

## Adım Adım
1. create-next-app --typescript
2. lib/ klasörlerini oluştur, yardımcıları kopyala/temizle
3. İlk GET endpoint'lerini yaz, DB bağlantısını doğrula
4. Daily success logic test (Jest) ekle
5. POST /api/daily/send taşı ve karşılaştırmalı test (legacy vs new) yap
6. Auto-fill route ekle (idempotent test)
7. Scheduler worker çıkar
8. Legacy sunucuyu read-only moda al → kapat

## Test Önerileri
- Unit: status hesaplama
- Integration: /api/daily/send 201 happy path
- Regression: Aynı gün tekrar gönderim skip

## Observability
- next-logger (pino) + request id
- Edge runtime kullanılmamalı (mssql native) → node runtime

## Risk Azaltma
- İlk 1 hafta çift yazma (parallel logging) opsiyonel
- Feature flag ile yeni POST endpoint'i kontrollü aç

