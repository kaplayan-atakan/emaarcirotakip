# 06 – Logging & Alerting

## Log Katmanları
| Katman | Açıklama |
|--------|----------|
| Application Console | Operasyonel akış, debug (stdout) |
| personelLog (DB) | Günlük/auto-fill gönderim kayıtları |
| aylikGonderimLog | Aylık özet gönderimleri |
| Email Alerts | Hata / kritik uyarı |

## Alerting (alerting.js)
Özellikler:
- severity: CRITICAL / ERROR / WARN (basit renk / subject farklılaşması)
- Dedup (hash) → kısa sürede aynı hata spam engeli
- Rate limit (örn. 10 dk içinde tekrar) – logta SKIP etiketi
- Context truncation (body JSON 4000 char kesme)

## Hata Gönderim Arayüzü
```js
await sendErrorEmail({
  kullanici: 'SYSTEM: Daily Scheduler',
  source: 'DAILY_SCHEDULER',
  errorMessage: err.message,
  errorStack: err.stack,
  severity: 'ERROR',
  context: { route: '/send', payload }
});
```

## Başarı Emaili (Günlük)
- Ciro, Kişi, Tarih, Kullanıcı.

## Aylık Başarı Emaili
- Toplam ciro/kisi, eksik gün olmadığını doğrulama, günlük tablo.

## İyileştirme Alanları
| Başlık | Öneri |
|--------|-------|
| Structured Logging | pino / winston JSON format |
| Trace ID | Her request/job için uuid |
| Alert Channel | Slack / Teams webhook entegrasyonu |
| Persisted Alerts | DB tablo (alert_history) |

## Renk Kodları (Örnek)
| Severity | Renk |
|----------|------|
| CRITICAL | #b91c1c |
| ERROR | #dc2626 |
| WARN | #d97706 |
| INFO (plan) | #2563eb |

