# 08 – Aylık Toplama (Aggregation)

## Kaynaklar
- personelLog (günlük gönderim kayıtları)
- (Opsiyonel) DWH Fact tablosu (kontrol / doğrulama)

## Mantık
1. Hedef Ay: Yıl & Ay parametre veya *şu anki ay*.
2. Ay içindeki her gün için personelLog taranır:
   - Bir veya daha fazla 201 varsa gün başarılı.
   - Hiç 201 yoksa eksikGunler listesine eklenir.
3. Başarılı günlerin değerleri (kisiSayisi, ciro vb.) toplanır / raporlanır.

## Fonksiyonlar
- aylikVeriHesapla(yil, ay)
  - Döndürür: { gunler: [...], eksikGunler: [...], toplamlar: {...} }

## Performans Önerileri
- Tarihe index: personelLog(date)
- Sadece gerekli kolonları seç (SELECT minimal)
- Cache: Ay sabit kaldıkça yeniden hesaplama azaltılabilir

## Tutarlılık Kontrolleri
| Kontrol | Açıklama |
|---------|---------|
| Gün sayısı | Ayın gün sayısı = gunler.length + eksikGunler.length |
| Negatif değer | Hiçbir metrik negatif olmamalı |
| Aykırı spike | Günlük değer ortalamanın X katıysa işaretle |

## İleri Geliştirme
- DWH karşılaştırmalı sapma yüzdesi
- Günlük delta grafiği
- Anomali skoru (z-score)

