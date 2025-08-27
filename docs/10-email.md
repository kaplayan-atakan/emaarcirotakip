# 10 – E-posta Bildirimleri

## Amaç
Kritik hata, eksik gün raporu ve aylık özetleri otomatik iletmek.

## Katmanlar
1. alerting.js → düşük seviye gönderim + rate limit
2. İş mantığı (scheduler / endpoint) → mesaj üretir

## Türler
| Tür | Örnek | Sıklık |
|-----|-------|--------|
| Kritik Hata | API 500 / DB bağlantı | Anında |
| Eksik Gün Uyarısı | Dün başarısız oldu | Sabah 09:00 |
| Aylık Özet | Ay kapanış raporu | Ay bitince |

## Rate Limit Mantığı (Öneri)
Key = (severity + normalizedMessage)
- cache içinde 15 dk tekrarını bastır

## HTML Şablon Örneği
```html
<table style="font-family:Arial;font-size:13px;border-collapse:collapse">
  <tr><th align="left">Gün</th><th>Durum</th><th>Not</th></tr>
  <!-- rows -->
</table>
```

## İyileştirme Fikirleri
- Retry log grafiği (inline base64 png)
- DKIM/SPF doğrulama
- Gönderim metrikleri (success %, avg latency)

## Güvenlik
- Kimlik bilgileri .env
- STARTTLS zorunlu
- Gövde içinde hassas credential yok

