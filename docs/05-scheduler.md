# 05 – Scheduler

## Mevcut Durum (node-schedule)
| İş | Cron | Açıklama |
|----|------|----------|
| Günlük Gönderim | 0 17 * * * | Dünkü günü gönderir |
| Aylık Gönderim | 0 18 2 * * | Önceki ayın aylık raporu (2. gün 18:00) |

(Not: Kodda ek deneysel job kalıntıları olabilir.)

## Günlük Job Akışı
1. Hedef tarih = bugün - 1 (dd.MM.yyyy + iso).
2. gonderimDurum(tarih).sent → varsa atla.
3. DWH sorgu (tek satır)
4. API POST
5. personelLog insert (statuscode=201)
6. Başarı maili

## Aylık Job Akışı
1. Önceki ay (yıl, ay) belirlenir.
2. aylikVeriHesapla → eksik gün varsa abort + alert.
3. Eksik yoksa monthlyApiGonder → aylık log kaydı.
4. Başarı maili (aylık özet).

## Next.js Geçişi
Next.js (Vercel) edge ortamında kalıcı cron yok; alternatifler:
- Harici cron (GitHub Actions, Azure WebJob) → /api/cron/daily veya /api/cron/monthly endpoint’i tetikler.
- PM2 / Systemd → node script (standalone worker) aynı repo içinde.

## Önerilen Ayrıştırma
- /worker klasörü: sadece cron işlerini içeren minimal Node entrypoint.
- API route’ları pure business logic çağırır (paylaşılan lib).

## Dayanıklılık İyileştirmeleri
| Problem | Öneri |
|---------|-------|
| Tek deneme başarısız | Retry stratejisi ekle |
| Zamanlama çakışması | Dağıtık lock (Redis key) |
| Uzayan job | Timeout + uyarı |

## Gözlemlenebilirlik
- Her job başlangıç/bitiş logu + duration.
- Prometheus counter: daily_job_runs_total, monthly_job_runs_total

