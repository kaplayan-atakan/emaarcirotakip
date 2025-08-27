# Emaar Ciro Takip – Dokümantasyon Paketi

Bu klasör, mevcut Node.js (Express) uygulamasını yeniden inşa ederken ve Next.js tabanlı yeni mimariye geçirirken ihtiyaç duyacağınız temel açıklamaları içerir.

## İçerik Haritası
- 01-architecture.md – Genel mimari, modüller, veri akışı
- 02-environment.md – Ortam değişkenleri ve yapılandırma
- 03-database.md – MSSQL şema, kullanılan tablolar, sorgu kalıpları
- 04-api-integration.md – Emaar API entegrasyonu (daily / monthly)
- 05-scheduler.md – Zamanlanmış işler ve job mantığı
- 06-logging-alerting.md – Log yapısı, personelLog, aylık log ve alerting mekanizması
- 07-autofill.md – Eksik gün tamamlama (Auto-Fill) süreci
- 08-monthly-aggregation.md – Aylık hesaplama (LOG bazlı) mantığı
- 09-security-auth.md – AD (LDAP) ve basit login akışı
- 10-email.md – SMTP yapılandırması, başarı / hata e-postaları
- 11-next-migration-guide.md – Next.js geçiş stratejisi, sayfa ve API mapping
- 12-deployment.md – Önerilen dağıtım & servisleştirme notları
- 13-risk-checklist.md – Veri bütünlüğü riskleri ve önlemler
- 14-future-improvements.md – Yol haritası / öneriler

Her dosya modülerdir; Next.js yeniden yazımı sırasında ilgili parçayı kolayca taşıyabilirsiniz.

---

## Hızlı Özet (TL;DR)
- Günlük veri kaynağı: DWH.FactKisiSayisiCiro (Şube Kodu=17672) → API’ye tek günlük payload.
- Başarı kriteri: personelLog.statuscode=201 (tablo='ciro').
- Aylık hesap: Sadece personelLog’taki başarılı günlüklerin toplanması (retrieval, re-sum DWH yok).
- Eksik gün: Beklenen gün listesinde 201 bulunmayan gün.
- Auto-Fill: Eksik veya isteğe bağlı retry (başarısız) günler için DWH’den okuyup API’ye post.
- Hata emaili: alerting.js seviyesi (CRITICAL/ERROR/WARN) + rate-limit + dedup.

## Lisans / Gizlilik
Bu doküman şirket içi kullanım içindir. Kimlik bilgileri (şifreler) üretim ortamına aktarılmadan önce .env’e taşınmalıdır.

---

Devam: Ayrıntılar için diğer dosyalara bakınız.
