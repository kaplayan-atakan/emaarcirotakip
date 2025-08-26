-- Aylık gönderim takibi için yeni tablo
-- Bu script'i RESTO_16 veritabanında çalıştırın

USE RESTO_16;
GO

-- Tablo varsa sil (geliştirme aşamasında)
-- IF OBJECT_ID('basar.aylikGonderimLog', 'U') IS NOT NULL
--     DROP TABLE basar.aylikGonderimLog;
-- GO

-- Aylık gönderim log tablosu oluştur
CREATE TABLE basar.aylikGonderimLog (
    id INT IDENTITY(1,1) PRIMARY KEY,
    yil INT NOT NULL,
    ay INT NOT NULL,
    toplamCiro DECIMAL(18,2) NOT NULL,
    toplamKisi INT NOT NULL,
    gonderimTarihi DATETIME DEFAULT GETDATE(),
    kullaniciTipi VARCHAR(50) NOT NULL, -- 'MANUAL' veya 'SCHEDULER'
    kullaniciAdi VARCHAR(100) NOT NULL,
    apiCevap TEXT,
    durum VARCHAR(20) DEFAULT 'BASARILI', -- 'BASARILI', 'HATA'
    
    -- Aynı ay için sadece bir başarılı gönderim olsun
    CONSTRAINT UK_aylikGonderim_YilAy_Basarili 
        UNIQUE (yil, ay, durum) 
        WHERE durum = 'BASARILI',
    
    -- Ay değeri 1-12 arasında olmalı
    CONSTRAINT CK_aylikGonderim_Ay 
        CHECK (ay >= 1 AND ay <= 12),
    
    -- Yıl makul bir değer olmalı
    CONSTRAINT CK_aylikGonderim_Yil 
        CHECK (yil >= 2020 AND yil <= 2050),
    
    -- Ciro negatif olamaz
    CONSTRAINT CK_aylikGonderim_Ciro 
        CHECK (toplamCiro >= 0),
    
    -- Kişi sayısı negatif olamaz
    CONSTRAINT CK_aylikGonderim_Kisi 
        CHECK (toplamKisi >= 0)
);
GO

-- İndeksler oluştur
CREATE INDEX IX_aylikGonderimLog_YilAy 
    ON basar.aylikGonderimLog (yil, ay);

CREATE INDEX IX_aylikGonderimLog_Tarih 
    ON basar.aylikGonderimLog (gonderimTarihi);

CREATE INDEX IX_aylikGonderimLog_Durum 
    ON basar.aylikGonderimLog (durum);
GO

-- Test verisi ekle (opsiyonel - test için)
/*
INSERT INTO basar.aylikGonderimLog 
(yil, ay, toplamCiro, toplamKisi, kullaniciTipi, kullaniciAdi, apiCevap, durum)
VALUES 
(2025, 6, 125000.50, 2850, 'SCHEDULER', 'SYSTEM: Otomatik Aylık Scheduler', '{"success": true}', 'BASARILI');
*/

-- Tablonun oluşturulduğunu kontrol et
SELECT 
    'basar.aylikGonderimLog tablosu başarıyla oluşturuldu!' as Mesaj,
    COUNT(*) as KayitSayisi
FROM basar.aylikGonderimLog;
GO

PRINT 'Aylık gönderim tablosu hazır! ✅';
