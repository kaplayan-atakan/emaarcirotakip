# 07 – Auto-Fill (Eksik Gün Tamamlama)

## Amaç
LOG tabanlı aylık hesaplamada eksik (statuscode=201 olmayan) günleri DWH’den okuyup API’ye göndererek tamamlamak.

## İş Akışı
1. aylikVeriHesapla → eksikGunler[] üret.
2. tamamlaEksikGunler(yil, ay) her eksik gün için:
   - DWH’de gün var mı? Yoksa notFoundDays.
   - Idempotent kontrol: personelLog’ta aynı gün 201 var mı? → varsa skip (sentDays).
   - API POST → success: sentDays, fail: failedDays.
3. Sonuç JSON döndürülür.

## Retry Genişletmesi (Ek Endpoint)
`/monthly-autofill-run` includeFailed=true → statuscode!=201 günleri de yeniden dener (retrySentDays / retryFailedDays).

## Örnek Dönen JSON
```json
{
  "success": true,
  "sonuc": {
    "sentDays": ["05.07.2025"],
    "notFoundDays": ["12.07.2025"],
    "failedDays": ["18.07.2025"],
    "retrySentDays": ["07.07.2025"],
    "retryFailedDays": ["09.07.2025"],
    "retriedDays": ["07.07.2025","09.07.2025"]
  }
}
```

## Edge Durumları
| Durum | Davranış |
|-------|----------|
| DWH boş gün | notFoundDays |
| Paralel çalıştırma | Idempotent kontrol aynı gün ikinci eklemeyi engeller |
| API 400 | failedDays (manuel inceleme gerekir) |

## Önerilen İyileştirmeler
- Batch gönderim (performans için)
- Gün listesi seçerek manuel auto-fill
- Eksik gün e-mail raporu (sabah 09:00)

