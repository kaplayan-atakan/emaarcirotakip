const sql = require('mssql');

// RESTO_16 bağlantı konfigürasyonu
const restoConfig = {
    user: 'basar.sonmez',
    password: 'RB&?L9apz',
    server: '172.16.14.2',
    database: 'RESTO_16',
    options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
        connectTimeout: 30000,
        requestTimeout: 60000
    }
};

async function createMonthlyTable() {
    let pool = null;
    
    try {
        console.log('🔗 RESTO_16 veritabanına bağlanıyor...');
        pool = new sql.ConnectionPool(restoConfig);
        await pool.connect();
        console.log('✅ Bağlantı başarılı!');
        
        // Tablo var mı kontrol et
        const checkTableQuery = `
            SELECT COUNT(*) as TableExists 
            FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_SCHEMA = 'basar' 
            AND TABLE_NAME = 'aylikGonderimLog'
        `;
        
        const checkResult = await pool.request().query(checkTableQuery);
        
        if (checkResult.recordset[0].TableExists > 0) {
            console.log('⚠️ basar.aylikGonderimLog tablosu zaten mevcut!');
            return;
        }
        
        console.log('📊 basar.aylikGonderimLog tablosu oluşturuluyor...');
        
        // Tablo oluştur
        const createTableQuery = `
            CREATE TABLE basar.aylikGonderimLog (
                id INT IDENTITY(1,1) PRIMARY KEY,
                yil INT NOT NULL,
                ay INT NOT NULL,
                toplamCiro DECIMAL(18,2) NOT NULL,
                toplamKisi INT NOT NULL,
                gonderimTarihi DATETIME DEFAULT GETDATE(),
                kullaniciTipi VARCHAR(50) NOT NULL,
                kullaniciAdi VARCHAR(100) NOT NULL,
                apiCevap TEXT,
                durum VARCHAR(20) DEFAULT 'BASARILI',
                
                CONSTRAINT CK_aylikGonderim_Ay CHECK (ay >= 1 AND ay <= 12),
                CONSTRAINT CK_aylikGonderim_Yil CHECK (yil >= 2020 AND yil <= 2050),
                CONSTRAINT CK_aylikGonderim_Ciro CHECK (toplamCiro >= 0),
                CONSTRAINT CK_aylikGonderim_Kisi CHECK (toplamKisi >= 0)
            );
        `;
        
        await pool.request().query(createTableQuery);
        console.log('✅ Tablo başarıyla oluşturuldu!');
        
        // İndeksler oluştur
        console.log('📝 İndeksler oluşturuluyor...');
        
        await pool.request().query(`
            CREATE INDEX IX_aylikGonderimLog_YilAy 
                ON basar.aylikGonderimLog (yil, ay);
        `);
        
        await pool.request().query(`
            CREATE INDEX IX_aylikGonderimLog_Tarih 
                ON basar.aylikGonderimLog (gonderimTarihi);
        `);
        
        await pool.request().query(`
            CREATE INDEX IX_aylikGonderimLog_Durum 
                ON basar.aylikGonderimLog (durum);
        `);
        
        console.log('✅ İndeksler başarıyla oluşturuldu!');
        
        // Test verisi ekle (opsiyonel)
        console.log('🧪 Test verisi ekleniyor...');
        await pool.request().query(`
            INSERT INTO basar.aylikGonderimLog 
            (yil, ay, toplamCiro, toplamKisi, kullaniciTipi, kullaniciAdi, apiCevap, durum)
            VALUES 
            (2025, 6, 125000.50, 2850, 'SCHEDULER', 'SYSTEM: Test Verisi', '{"success": true, "test": true}', 'BASARILI');
        `);
        
        // Kontrol et
        const countResult = await pool.request().query(`
            SELECT COUNT(*) as TotalRecords FROM basar.aylikGonderimLog
        `);
        
        console.log(`🎉 İşlem tamamlandı! Toplam kayıt: ${countResult.recordset[0].TotalRecords}`);
        console.log('📊 basar.aylikGonderimLog tablosu kullanıma hazır!');
        
    } catch (error) {
        console.error('❌ Hata oluştu:', error.message);
        console.error('📍 Detay:', error);
    } finally {
        if (pool) {
            await pool.close();
            console.log('🔒 Bağlantı kapatıldı.');
        }
    }
}

// Script'i çalıştır
console.log('🚀 Aylık gönderim tablosu kurulum script\'i başlatılıyor...');
createMonthlyTable().then(() => {
    console.log('✅ Kurulum tamamlandı!');
    process.exit(0);
}).catch((error) => {
    console.error('❌ Kurulum hatası:', error);
    process.exit(1);
});
