# 04 – Emaar API Entegrasyonu

## Daily Payload Format
```json
[
  {
    "SalesFromDATE": "2025-08-15",
    "SalesToDATE": "2025-08-15",
    "NetSalesAmount": "49569.09",
    "NoofTransactions": "149",
    "SalesFrequency": "Daily",
    "PropertyCode": "ESM",
    "LeaseCode": "t0000967",
    "SaleType": "food"
  }
]
```

## Monthly Payload (Varsayım / Eğer tek POST ile aggregate gerekiyorsa)
(Not: Kod içinde aylık gönderim mantığı örneklenmiş; aynı alan adları kullanılmalı.)

## HTTP Başlıkları
```http
Content-Type: application/json
Accept: application/json
Authorization: <Bearer/Key>
X-Api-Key: <key> (varsa)
```

## Başarı Kriteri
- HTTP 201 → personelLog.statuscode=201
- Diğer kodlar → hata; response body loglanır ve alert tetiklenir.

## Tekrar Gönderim (Idempotency)
- API tarafı kendi idempotency’sini belirtmiyor → Uygulama logu baz; aynı gün tekrar gönderirken önce success var mı bakılır.

## Hata Yakalama Örüntüsü
```js
try { await axios.post(API_URL, payload, { headers }); }
catch (e) {
  const status = e.response?.status;
  const body   = e.response?.data;
  // log + alert
}
```

## Yaygın 400 Hata Nedenleri
| Neden | Çözüm |
|-------|-------|
| Tarih formatı (dd.MM.yyyy gönderilmesi) | ISO (yyyy-MM-dd) dönüştür |
| NetSalesAmount sayı yerine sayısal olmayan | toFixed(2) + string |
| NoofTransactions integer değil | parseInt → string |

## Retry Politikası (Öneri)
| Seviye | Bekleme | Deneme |
|--------|---------|--------|
| Network timeout | 2s artarak | 3 |
| 5xx | 5s sabit | 2 |
| 4xx | Retry yok (manuel inceleme) | 0 |

## İzleme / Metrikler
Toplanması önerilen metrikler (Next.js API route’larında):
- successes_total (counter)
- failures_total (counter, labeled by status)
- duration_ms (histogram)

Prometheus push / OpenTelemetry opsiyonel.

