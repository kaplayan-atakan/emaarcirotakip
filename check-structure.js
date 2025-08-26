const sql = require('mssql');

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

async function checkTableStructure() {
    let pool = null;
    
    try {
        console.log('🔍 TABLO YAPISI KONTROLEDİLİYOR');
        console.log('===============================\n');
        
        pool = new sql.ConnectionPool(restoConfig);
        await pool.connect();
        console.log('✅ RESTO bağlantısı kuruldu\n');
        
        // personelLog tablo yapısını kontrol et
        const columns = await pool.request().query(`
            SELECT 
                COLUMN_NAME,
                DATA_TYPE,
                IS_NULLABLE,
                CHARACTER_MAXIMUM_LENGTH
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = 'basar' AND TABLE_NAME = 'personelLog'
            ORDER BY ORDINAL_POSITION
        `);
        
        console.log('📋 personelLog TABLO SÜTUNLARI:');
        console.log('--------------------------------');
        columns.recordset.forEach(col => {
            console.log(`${col.COLUMN_NAME} - ${col.DATA_TYPE}${col.CHARACTER_MAXIMUM_LENGTH ? `(${col.CHARACTER_MAXIMUM_LENGTH})` : ''} - ${col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'}`);
        });
        
        // Örnek veri kontrol et
        console.log('\n📊 ÖRNEK VERİLER:');
        console.log('------------------');
        const samples = await pool.request().query(`
            SELECT TOP 3 * FROM basar.personelLog 
            WHERE tablo = 'ciro'
            ORDER BY logID DESC
        `);
        
        if (samples.recordset.length > 0) {
            console.log('İlk örnek kayıt:');
            Object.keys(samples.recordset[0]).forEach(key => {
                console.log(`  ${key}: ${samples.recordset[0][key]}`);
            });
        }
        
        // Manuel düzeltmeleri basit haliyle kontrol et
        console.log('\n🛠️ MANUEL DÜZELTMELERİN SAYISI:');
        console.log('--------------------------------');
        
        const manuelCount = await pool.request().query(`
            SELECT 
                COUNT(*) as ToplamManuel,
                COUNT(CASE WHEN statuscode = 201 THEN 1 END) as BasariliManuel
            FROM basar.personelLog 
            WHERE tablo = 'ciro'
        `);
        
        console.log(`Toplam ciro ile ilgili kayıt: ${manuelCount.recordset[0].ToplamManuel}`);
        console.log(`Başarılı düzeltme: ${manuelCount.recordset[0].BasariliManuel}`);
        
        if (manuelCount.recordset[0].BasariliManuel > 0) {
            const detaylar = await pool.request().query(`
                SELECT 
                    veri3 as Tarih,
                    CAST(veri1 AS DECIMAL(18,2)) as EskiDeger,
                    CAST(veri2 AS DECIMAL(18,2)) as YeniDeger,
                    (CAST(veri2 AS DECIMAL(18,2)) - CAST(veri1 AS DECIMAL(18,2))) as Fark
                FROM basar.personelLog 
                WHERE tablo = 'ciro'
                AND statuscode = 201
                ORDER BY logID DESC
            `);
            
            console.log('\nManuel düzeltme detayları:');
            let toplamFark = 0;
            detaylar.recordset.forEach((row, index) => {
                if (index < 5) { // İlk 5 tanesini göster
                    console.log(`  ${row.Tarih}: ${row.EskiDeger}₺ → ${row.YeniDeger}₺ (${row.Fark > 0 ? '+' : ''}${row.Fark.toFixed(2)}₺)`);
                }
                toplamFark += parseFloat(row.Fark);
            });
            
            if (detaylar.recordset.length > 5) {
                console.log(`  ... ve ${detaylar.recordset.length - 5} düzeltme daha`);
            }
            
            console.log(`\n💰 Toplam etki: ${toplamFark > 0 ? '+' : ''}${toplamFark.toFixed(2)}₺`);
        }
        
    } catch (error) {
        console.error('❌ Hata:', error.message);
    } finally {
        if (pool) await pool.close();
        console.log('\n✅ Kontrol tamamlandı.');
    }
}

// Script'i çalıştır
checkTableStructure();
