# 03 – Veritabanı (MSSQL) Yapısı

## Tablolar
### 1. `basar.personelLog`
Günlük (ve auto-fill) gönderimlerinin ham logu.

| Sütun | Tip | Açıklama |
|-------|-----|----------|
| tarih | datetime | Log insert zamanı (server now) |
| ip | varchar | Kaynağı (SCHEDULER / AUTO-FILL / kullanıcı IP) |
| kullanici | varchar | AD: user veya sistem | 
| tablo | varchar | 'ciro' sabit (ileride farklı türler için alan) |
| veri | text | Gönderilen payload JSON (string) |
| veri1 | varchar | Ciro (string) |
| veri2 | varchar | Kişi sayısı (string) |
| veri3 | varchar | Gün (dd.MM.yyyy) |
| cevap | text | API response veya hata mesajı |
| statuscode | int | HTTP (201 başarı) |

Önerilen indeksler:
```sql
CREATE NONCLUSTERED INDEX IX_personelLog_tablo_veri3_statuscode ON basar.personelLog(tablo, veri3, statuscode);
CREATE NONCLUSTERED INDEX IX_personelLog_statuscode_tarih ON basar.personelLog(statuscode, tarih DESC);
```

### 2. `basar.aylikGonderimLog`
Aylık özet gönderim kayıtları.

| Sütun | Tip | Açıklama |
|-------|-----|----------|
| id | int (PK, identity) |  |
| yil | int | Yıl |
| ay | int | Ay |
| toplamCiro | decimal(18,2) | LOG bazlı sum |
| toplamKisi | int | LOG bazlı sum |
| gonderimTarihi | datetime | Sunucu zamanı |
| kullaniciTipi | varchar | MANUAL / SYSTEM |
| kullaniciAdi | varchar | AD user |
| durum | varchar | BASARILI / HATA |

İndeks:
```sql
CREATE UNIQUE INDEX UX_aylikGonderimLog_yil_ay_durum ON basar.aylikGonderimLog(yil, ay, durum) WHERE durum='BASARILI';
```

### 3. DWH: `[DWH].[dbo].[FactKisiSayisiCiro]`
Kaynak (read-only) – Şube Kodu=17672 filtreli.

| Sütun | Not |
|-------|-----|
| Tarih | dd.MM.yyyy string; CONVERT(datetime, Tarih, 104) ile sıralanır |
| Ciro | numeric/decimal |
| Kişi Sayısı | int |
| Şube Kodu | 17672 |

## Aylık Hesap Mantığı (LOG Bazlı)
1..N gün listesi oluştur → personelLog statuscode=201 filtrele → sum(ciro,kisi) → missingDays = beklenen - mevcut.

## Tutarlılık Kontrolleri
- Duplicate success riskini azaltmak için (tarih + tablo + statuscode=201) unique constraint düşünülebilir:
```sql
ALTER TABLE basar.personelLog ADD CONSTRAINT UQ_personelLog_uniqueSuccess UNIQUE (tablo, veri3, statuscode);
```
(Not: statuscode=201’da tekrar gönderime izin vermek istiyorsan uygulama önce delete veya skip yapmalı.)

## Önerilen Bakım
- Eski log arşivleme (örn. > 180 gün) ayrı tabloya taşı.
- Index fragmentation haftalık rebuild.

